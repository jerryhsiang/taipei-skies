/* ============================================================
   Taipei Skies — js/aircraft.js
   Cessna 172-style four-seater B-15821: primitive-built 3D model,
   6-DoF-lite flight physics (substepped at <= 1/120 s), keyboard +
   mouse-stick input, ground handling, terrain / building collisions
   and crash logic.

   Exports FS.aircraft = { init(scene), group, eyePoint, chaseOffset,
     reset(opts), update(dt), state, params }  (see CONTRACT.md)
   Events emitted: 'touchdown', 'takeoff', 'crash', 'reset'.

   Additions to the contract (all optional for other modules):
     state.elevator / aileron / rudder are the COMMANDED stick values:
       elevator +1 = stick back (nose up), aileron +1 = roll right,
       rudder +1 = nose right.  state.surfaces = actual (slewed) positions.
     state.flaps = selected setting (0 / 0.5 / 1); state.flapPos = actual.
     state.parkingBrake, state.thrust, state.lift, state.drag (N),
     state.stallSpeed (m/s for the current flap setting), state.time,
     state.trimAlpha (deg, the auto-trim angle of attack).
     touchdown event also carries landingEnd (runway end whose heading
       best matches the aircraft; crossTrack / alongFromThreshold use it),
       pitch, roll, heading at contact. vs < -2.5 m/s = hard landing (bounce,
       no crash); vs < -6.5 m/s = crash.
     FS.aircraft.setThrottle(v), setFlaps(v), setBrakes(bool), setAttitude(h,p,r),
       extraInput {elevator, aileron, rudder} (autopilot / tests), parts, model.
   Handling model (arcade-friendly, see params.ctrl): the elevator commands an
   angle-of-attack change above an auto-trim that follows 1 g flight at the
   current speed (+0.8 g max at cruise, ~8-11 deg/s pitch rate, alpha limited
   to stall alpha - 2 deg, pull authority fading above 15-40 deg nose-up); a
   flight-path assist levels the path hands-off; a wings-level assist eases
   the bank out at ~3 deg/s when the ailerons are released.
   Hotkeys owned here: W/S A/D Q/E + arrows, Shift/Ctrl, PageUp/PageDown,
   mouse wheel, F, B, Space, mouse stick.
   ============================================================ */
(function () {
  'use strict';
  const FS = (window.FS = window.FS || {});
  const V3 = THREE.Vector3;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const wrap360 = (h) => { h %= 360; if (h < 0) h += 360; return h; };
  const wrap180 = (h) => ((((h + 180) % 360) + 360) % 360) - 180;
  const gravity = () => num(FS.CONFIG && FS.CONFIG.gravity, 9.81);

  // ---------------------------------------------------------------
  // Parameters (SI). Control gains are "angular acceleration per unit"
  // at the reference speed Vref and scale with (V/Vref)^2 (authority,
  // stability) or V/Vref (rate damping), like real aerodynamic moments.
  // ---------------------------------------------------------------
  const params = {
    name: 'Cessna 172', registration: 'B-15821',
    mass: 1100, wingArea: 16.2, wingSpan: 11, chord: 1.5,
    maxThrust: 2600, enginePower: 120000, propEfficiency: 0.8, idleThrustFrac: 0.03, propRadius: 0.95,
    gearHeight: 0.9,
    wheels: { nose: { x: 0, z: -1.6 }, mainL: { x: -1.1, z: 0.3 }, mainR: { x: 1.1, z: 0.3 } },
    aero: {
      CL0: 0.3, CL0Flaps: 0.55, CLa: 5.2, stallAlpha: 16, stallAlphaFlaps: 17, stallAlphaNeg: -12, stallWidth: 10,
      CD0: 0.035, CD0Flaps: 0.035, kInduced: 0.055, CYbeta: -0.35, CDbeta: 0.4, trimAlpha: 2,
    },
    ctrl: {
      Vref: 60,
      // elevator commands an angle-of-attack change above the auto-trim: elevDeltaAlpha at/below elevRefSpeed,
      // falling with 1/V^2 above it (=> roughly constant +0.7 g for full back stick at cruise, ~10 deg/s pitch rate)
      pitchStab: 30, pitchDamp: 7.7, elevDeltaAlpha: 14, elevRefSpeed: 26, alphaMargin: 2, attLimitStart: 15, attLimitEnd: 40, trimTau: 1.2, trimAlphaMax: 11, pathAssist: 5,
      rollAuth: 5.4, rollDamp: 5, dihedral: 6, levelRate: 3, levelMaxBank: 40,
      yawAuth: 1.2, yawStab: 8, yawDamp: 2.5, coord: 0.4, adverse: 0.25,
      slewKey: 2.5, slewMouse: 4,
    },
    ground: { steerRate: 40, steerFade: 30, brakeDecel: 3, rollResPaved: 0.02, rollResSoft: 0.08, noseHold: 2.2, noseHoldFadeSpeed: 24, groundPitch: 0, maxPitch: 14 },
    limits: { crashVs: -6.5, hardVs: -2.5, crashRoll: 15, crashPitchMin: -5, crashPitchMax: 18, crashSlope: 7, offAirportSpeed: 30, worldLimit: 40000, buildingAlt: 600 },
    rpm: { idle: 700, max: 2700 },
    vSpeeds: { rotate: 28, approach: 33, stall: 24, stallFlaps: 21, cruise: 60, never: 82 },
  };

  // ---------------------------------------------------------------
  // Optional peers (world / city / airports may be missing or partial)
  // ---------------------------------------------------------------
  const peers = {
    height(x, z) {
      const w = FS.world;
      if (w && typeof w.getHeight === 'function') { const h = w.getHeight(x, z); return typeof h === 'number' && isFinite(h) ? h : 0; }
      return 0;
    },
    isWater(x, z) { const w = FS.world; return !!(w && typeof w.isWater === 'function' && w.isWater(x, z)); },
    obstacleTop(x, z) {
      const c = FS.city;
      if (c && typeof c.getObstacleTop === 'function') { const t = c.getObstacleTop(x, z); return typeof t === 'number' ? t : -Infinity; }
      return -Infinity;
    },
    onRunway(x, z) { const a = FS.airports; return a && typeof a.isOnRunway === 'function' ? (a.isOnRunway(x, z) || null) : null; },
    onPaved(x, z) { const a = FS.airports; return !!(a && typeof a.isOnPaved === 'function' && a.isOnPaved(x, z)); },
    runwayEnds() { const a = FS.airports; const e = a && typeof a.getRunwayEnds === 'function' ? a.getRunwayEnds() : null; return Array.isArray(e) ? e : []; },
  };
  function emit(name, data) { if (FS.events && typeof FS.events.emit === 'function') FS.events.emit(name, data); }
  const warned = new Set();
  function warnOnce(key, e) { if (warned.has(key)) return; warned.add(key); console.warn('[aircraft] ' + key, e || ''); }

  // ---------------------------------------------------------------
  // Simulation state (world frame: x east, z south, y up; body: -Z fwd, +Y up, +X right)
  // ---------------------------------------------------------------
  const pos = new V3(), vel = new V3(), quat = new THREE.Quaternion();
  const fwd = new V3(0, 0, -1), up = new V3(0, 1, 0), right = new V3(1, 0, 0);
  // body angular rates: x = pitch rate (+ nose up), y = yaw rate (+ nose LEFT), z = roll rate (+ LEFT wing down)
  const omega = new V3();
  const ctrl = { e: 0, a: 0, r: 0 };   // actual (slewed) surface positions, -1..1
  const cmd = { e: 0, a: 0, r: 0 };    // commanded this frame (keyboard + mouse + extra, clamped)
  const cmdK = { e: 0, a: 0, r: 0 }, cmdM = { e: 0, a: 0, r: 0 };   // keyboard part / mouse+scripted part of the command
  const ctrlK = { e: 0, a: 0, r: 0 }, ctrlM = { e: 0, a: 0, r: 0 }; // slewed separately (keys ~2.5/s, mouse ~4/s)
  let alphaTrim = 0, contactSuppress = 0;
  let throttle = 0, rpm = 700, flapSel = 0, flapPos = 0, parkingBrake = false, brakeHeld = false;
  let onGround = true, airTime = 0, groundTime = 0, liftoffEnd = null, takeoffPending = false, armed = false;
  let alphaRad = 0, betaRad = 0, airspeed = 0, gForce = 1, thrustN = 0, liftN = 0, dragN = 0, stallFlag = false;
  let terrainH = 0, headingDeg = 0, pitchDeg = 0, rollDeg = 0, simTime = 0, lightTime = 0;
  const crash = { active: false, t: 0, spin: new V3(), settled: false };
  const wind = new V3();
  let group = new THREE.Group(), modelGroup = null, parts = null, initialized = false;

  const state = {
    pos, vel, quat, forward: fwd, up, right,
    airspeed: 0, groundSpeed: 0, altitude: 0, agl: 0, heading: 0, pitch: 0, roll: 0, vs: 0, alpha: 0, beta: 0,
    throttle: 0, rpm: 700, flaps: 0, flapPos: 0, brakes: false, parkingBrake: false, onGround: true, onRunway: null,
    crashed: false, crashReason: '', stall: false, gForce: 1, terrainHeight: 0,
    elevator: 0, aileron: 0, rudder: 0, mouseActive: false,
    surfaces: { elevator: 0, aileron: 0, rudder: 0 }, thrust: 0, lift: 0, drag: 0, stallSpeed: 24, time: 0, trimAlpha: 0,
  };

  // scratch
  const vAir = new V3(), vb = new V3(), qc = new THREE.Quaternion(), ev = new V3(), liftDir = new V3(), Fb = new V3(), F = new V3();
  const fwdH = new V3(), rightH = new V3(), tmp = new V3(), tmp2 = new V3(), dq = new THREE.Quaternion(), eul = new THREE.Euler();
  const snap = { pos: new V3(), vel: new V3(), quat: new THREE.Quaternion(), omega: new V3() };

  // ---------------------------------------------------------------
  // Aerodynamic coefficient curves
  // ---------------------------------------------------------------
  function stallBlend(a, flap) {
    const A = params.aero;
    const as = (A.stallAlpha + (A.stallAlphaFlaps - A.stallAlpha) * flap) * D2R;
    const an = A.stallAlphaNeg * D2R, w = A.stallWidth * D2R;
    if (a > as) return smooth01((a - as) / w);
    if (a < an) return smooth01((an - a) / w);
    return 0;
  }
  function liftCoef(a, flap, t) {
    const A = params.aero;
    const lin = A.CL0 + A.CL0Flaps * flap + A.CLa * a;
    if (t <= 0) return lin;
    const flat = Math.sin(2 * a); // flat-plate lift past the stall
    return lin * (1 - t) + flat * t;
  }
  function dragCoef(cl, a, flap, t, beta, agl) {
    const A = params.aero;
    // ground effect: induced drag falls off within about one wingspan of the ground
    const hb = clamp(agl / params.wingSpan, 0, 1);
    const k = A.kInduced * (1 - 0.35 * (1 - hb) * (1 - hb));
    const sa = Math.sin(a);
    return A.CD0 + A.CD0Flaps * flap + k * cl * cl + t * 1.0 * sa * sa + A.CDbeta * beta * beta;
  }
  function maxLiftCoef(flap) {
    let best = 0;
    for (let d = 10; d <= 24; d += 0.5) { const a = d * D2R; const c = liftCoef(a, flap, stallBlend(a, flap)); if (c > best) best = c; }
    return best;
  }
  function stallSpeed(flap) {
    const rho0 = num(FS.CONFIG && FS.CONFIG.rho, 1.225);
    return Math.sqrt((2 * params.mass * gravity()) / (rho0 * params.wingArea * Math.max(0.5, maxLiftCoef(flap))));
  }
  // angle of attack (rad) for level flight at the given speed / flap setting (the auto-trim target)
  function levelAlphaRad(speed, flap, rho, loadFactor) {
    const A = params.aero;
    const clReq = (2 * params.mass * gravity() * (loadFactor == null ? 1 : loadFactor)) / (rho * speed * speed * params.wingArea);
    return clamp((clReq - A.CL0 - A.CL0Flaps * flap) / A.CLa, -4 * D2R, params.ctrl.trimAlphaMax * D2R);
  }
  function levelPitchFor(speed, flap) {
    if (speed < 15) return 0;
    const A = params.aero, rho0 = num(FS.CONFIG && FS.CONFIG.rho, 1.225);
    const clReq = (2 * params.mass * gravity()) / (rho0 * speed * speed * params.wingArea);
    return clamp(((clReq - A.CL0 - A.CL0Flaps * flap) / A.CLa) * R2D, -3, 10);
  }

  // ---------------------------------------------------------------
  // Attitude helpers
  // ---------------------------------------------------------------
  function computeAxes() {
    fwd.set(0, 0, -1).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);
    right.set(1, 0, 0).applyQuaternion(quat);
  }
  function computeAngles() {
    // intrinsic yaw (Y) -> pitch (X) -> roll (Z); body forward is -Z so +Z rotation is a LEFT roll
    eul.setFromQuaternion(quat, 'YXZ');
    headingDeg = wrap360(-eul.y * R2D);
    pitchDeg = eul.x * R2D;
    rollDeg = -eul.z * R2D;
  }
  function setAttitude(heading, pitch, roll) {
    eul.set(pitch * D2R, FS.geo ? FS.geo.headingToYaw(heading) : -heading * D2R, -roll * D2R, 'YXZ');
    quat.setFromEuler(eul).normalize();
    computeAxes(); computeAngles();
  }
  function updateWind() {
    const w = FS.CONFIG && FS.CONFIG.wind;
    if (w && isFinite(w.speed) && isFinite(w.fromDeg) && FS.geo) {
      const d = FS.geo.headingToDir(w.fromDeg + 180);
      wind.set(d.x * w.speed, 0, d.z * w.speed);
    } else wind.set(0, 0, 0);
  }

  // ---------------------------------------------------------------
  // Terrain / airport queries
  // ---------------------------------------------------------------
  function slopeDeg(x, z) {
    const d = 4;
    const hx = peers.height(x + d, z) - peers.height(x - d, z);
    const hz = peers.height(x, z + d) - peers.height(x, z - d);
    return Math.atan(Math.hypot(hx, hz) / (2 * d)) * R2D;
  }
  function onAirport(x, z) {
    if (peers.onPaved(x, z) || peers.onRunway(x, z)) return true;
    const ends = peers.runwayEnds();
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i];
      if (!e || !e.center || !e.dir) continue;
      const rx = x - e.center.x, rz = z - e.center.z;
      const along = rx * e.dir.x + rz * e.dir.z, cross = rx * -e.dir.z + rz * e.dir.x;
      if (Math.abs(along) < num(e.length, 2500) / 2 + 500 && Math.abs(cross) < 350) return true;
    }
    return false;
  }
  // lowest wheel clearance above the terrain under it (uses the real attitude)
  function wheelClearance() {
    const W = params.wheels, gh = params.gearHeight;
    let minClr = Infinity;
    const list = [W.nose, W.mainL, W.mainR];
    for (let i = 0; i < 3; i++) {
      tmp.set(list[i].x, -gh, list[i].z).applyQuaternion(quat).add(pos);
      const c = tmp.y - peers.height(tmp.x, tmp.z);
      if (c < minClr) minClr = c;
    }
    return minClr;
  }
  function touchdownInfo(vs, gs, x, z) {
    const end = peers.onRunway(x, z);
    const ends = peers.runwayEnds();
    const sameRunway = (a, b) => a && b && a.center && b.center && Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z) < 1;
    let cands = [];
    if (end) cands = ends.filter((e) => sameRunway(e, end));
    if (!cands.length && ends.length) {
      let best = null, bd = Infinity;
      for (const e of ends) { if (!e || !e.center) continue; const d = Math.hypot(x - e.center.x, z - e.center.z); if (d < bd) { bd = d; best = e; } }
      if (best && bd < 5000) cands = ends.filter((e) => sameRunway(e, best));
    }
    let match = null, bestDiff = Infinity;
    for (const e of cands) {
      if (!e || typeof e.heading !== 'number') continue;
      const d = Math.abs(wrap180(headingDeg - e.heading));
      if (d < bestDiff) { bestDiff = d; match = e; }
    }
    let crossTrack = null, along = null;
    if (match && match.threshold && match.dir) {
      const rx = x - match.threshold.x, rz = z - match.threshold.z;
      crossTrack = rx * -match.dir.z + rz * match.dir.x;
      along = rx * match.dir.x + rz * match.dir.z;
    }
    return { vs, speed: gs, x, z, runwayEnd: end, landingEnd: match, crossTrack, alongFromThreshold: along, hard: vs < -2.5,
      pitch: pitchDeg, roll: rollDeg, heading: headingDeg };
  }

  // ---------------------------------------------------------------
  // Crash / liftoff / contact transitions
  // ---------------------------------------------------------------
  function doCrash(reason) {
    if (crash.active) return;
    crash.active = true; crash.t = 0; crash.settled = false;
    crash.spin.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.2);
    if (!onGround) crash.spin.multiplyScalar(1.6);
    state.crashed = true; state.crashReason = reason;
    stallFlag = false;
    emit('crash', { reason });
  }
  function liftoff() {
    onGround = false; airTime = 0; armed = false; takeoffPending = true;
    liftoffEnd = peers.onRunway(pos.x, pos.z);
    contactSuppress = Math.max(contactSuppress, 2.0); // settling straight back is not a landing
  }
  function contactGround() {
    const L = params.limits;
    const vs = vel.y, gs = Math.hypot(vel.x, vel.z), x = pos.x, z = pos.z;
    let reason = '';
    if (peers.isWater(x, z)) reason = 'Ditched in the water';
    else if (slopeDeg(x, z) > L.crashSlope) reason = 'Flew into terrain';
    else if (vs < L.crashVs) reason = 'Hard impact — ' + Math.round(-vs * 196.85) + ' ft/min';
    else if (Math.abs(rollDeg) > L.crashRoll) reason = 'Wingtip struck the ground';
    else if (pitchDeg < L.crashPitchMin) reason = 'Nose-first impact';
    else if (pitchDeg > L.crashPitchMax) reason = 'Tail strike';
    else if (gs > L.offAirportSpeed && !onAirport(x, z)) reason = 'Struck the ground off-airport at ' + Math.round(gs * 1.943844) + ' kt';
    if (reason) { doCrash(reason); return; }
    const info = touchdownInfo(vs, gs, x, z);
    omega.multiplyScalar(0.3);
    if (vs < L.hardVs) {
      // hard landing: bounce a little and stay airborne for a moment
      vel.y = Math.min(2.0, -0.3 * vs); pos.y = terrainH + params.gearHeight + 0.02; armed = false;
    } else {
      onGround = true; groundTime = 0; armed = false; takeoffPending = false; airTime = 0;
      vel.y = 0; pos.y = terrainH + params.gearHeight;
    }
    if (contactSuppress <= 0) emit('touchdown', info);
    contactSuppress = 3.0;
  }

  // ---------------------------------------------------------------
  // One physics substep
  // ---------------------------------------------------------------
  function step(h) {
    const P = params, A = P.aero, C = P.ctrl, GR = P.ground;
    const mass = P.mass, g = gravity();

    // control surfaces slew toward the command; flaps travel; engine lag
    const sk = C.slewKey * h, sm = C.slewMouse * h;
    ctrlK.e += clamp(cmdK.e - ctrlK.e, -sk, sk); ctrlK.a += clamp(cmdK.a - ctrlK.a, -sk, sk); ctrlK.r += clamp(cmdK.r - ctrlK.r, -sk, sk);
    ctrlM.e += clamp(cmdM.e - ctrlM.e, -sm, sm); ctrlM.a += clamp(cmdM.a - ctrlM.a, -sm, sm); ctrlM.r += clamp(cmdM.r - ctrlM.r, -sm, sm);
    ctrl.e = clamp(ctrlK.e + ctrlM.e, -1, 1); ctrl.a = clamp(ctrlK.a + ctrlM.a, -1, 1); ctrl.r = clamp(ctrlK.r + ctrlM.r, -1, 1);
    if (contactSuppress > 0) contactSuppress -= h;
    const fl = 0.25 * h;
    flapPos += clamp(flapSel - flapPos, -fl, fl);
    const rpmT = P.rpm.idle + (P.rpm.max - P.rpm.idle) * throttle;
    rpm += (rpmT - rpm) * (1 - Math.exp(-h / 0.35));
    const powerFrac = clamp((rpm - P.rpm.idle) / (P.rpm.max - P.rpm.idle), 0, 1);

    terrainH = peers.height(pos.x, pos.z);
    const alt = pos.y, agl = alt - terrainH;
    const rho = num(FS.CONFIG && FS.CONFIG.rho, 1.225) * Math.exp(-Math.max(0, alt) / 9300);

    computeAxes(); computeAngles();
    const pitchRad = pitchDeg * D2R, rollRad = rollDeg * D2R;

    // air-relative velocity in body axes: u forward, vSide right, w down
    vAir.copy(vel).sub(wind);
    const V = vAir.length();
    qc.copy(quat).conjugate();
    vb.copy(vAir).applyQuaternion(qc);
    const u = -vb.z, vSide = vb.x, w = -vb.y;
    if (V > 1) { alphaRad = Math.atan2(w, u); betaRad = Math.asin(clamp(vSide / V, -1, 1)); }
    else { alphaRad = 0; betaRad = 0; }
    airspeed = V;

    // propeller thrust: static limit or power limit, scaled by engine power fraction (idle keeps a trickle)
    const Tavail = Math.min(P.maxThrust, (P.propEfficiency * P.enginePower) / Math.max(V, 1));
    thrustN = Tavail * (P.idleThrustFrac + (1 - P.idleThrustFrac) * powerFrac);

    // aerodynamic forces in the wind frame
    const qbar = 0.5 * rho * V * V, S = P.wingArea;
    const tStall = stallBlend(alphaRad, flapPos);
    const CL = liftCoef(alphaRad, flapPos, tStall);
    const CD = dragCoef(CL, alphaRad, flapPos, tStall, betaRad, agl);
    liftN = qbar * S * CL; dragN = qbar * S * CD;
    const sideN = qbar * S * A.CYbeta * betaRad;
    if (V > 0.5) ev.copy(vb).multiplyScalar(1 / V); else ev.set(0, 0, -1);
    liftDir.set(0, -ev.z, ev.y);                     // perpendicular to the relative wind, in the plane of symmetry
    const ll = liftDir.length();
    if (ll > 1e-6) liftDir.multiplyScalar(1 / ll); else liftDir.set(0, 1, 0);
    Fb.set(sideN, 0, -thrustN).addScaledVector(liftDir, liftN).addScaledVector(ev, -dragN);
    F.copy(Fb).applyQuaternion(quat);
    F.y -= mass * g;

    // ---- moments as angular accelerations (rad/s^2) ----
    const Vc = C.Vref;
    const discA = Math.PI * P.propRadius * P.propRadius;
    const Vt = Math.sqrt(V * V + (0.3 * 2 * thrustN) / (rho * discA)); // tail sits in the prop slipstream
    const v1 = Math.min(V / Vc, 1.6), v2 = v1 * v1;
    const t1 = Math.min(Vt / Vc, 1.6), t2 = t1 * t1;
    const qr = omega.x, rr = -omega.y, pr = -omega.z;  // pitch (+up), yaw (+right), roll (+right wing down)
    const hv = Math.hypot(vel.x, vel.z);
    // auto-trim: the trim angle of attack follows level flight at the current speed (0 on the ground), so a released
    // stick means ~1 g; the elevator commands an angle-of-attack change on top of it (large at low speed, ~2 deg at cruise)
    const gamma = hv > 1 ? Math.atan2(vel.y, hv) : 0;                     // flight-path angle
    const trimTarget = onGround ? 0 : levelAlphaRad(Math.max(V, 15), flapPos, rho, Math.max(0.3, Math.cos(gamma))); // steady climb/descent: n = cos(gamma)
    alphaTrim += (trimTarget - alphaTrim) * (1 - Math.exp(-h / C.trimTau));
    let dAlphaMax = C.elevDeltaAlpha * D2R * Math.min(1, Math.pow(C.elevRefSpeed / Math.max(V, 1), 2));
    // attitude limiter: pulling (pushing) loses authority between 15 and 40 deg nose up (down), so a held stick
    // settles into a steep climb / dive instead of looping
    if (!onGround) {
      const att = ctrl.e > 0 ? pitchDeg : -pitchDeg;
      dAlphaMax *= 1 - smooth01((att - C.attLimitStart) / (C.attLimitEnd - C.attLimitStart));
    }
    // flight-path assist: with the stick near neutral, gently level the flight path (damps the phugoid, no hands-off dive)
    const eAssist = onGround ? 0 : 1 - smooth01((Math.abs(cmd.e) - 0.05) / 0.15);
    // angle-of-attack limiter: the stick cannot command past (stall alpha - margin), so sustained full back stick settles
    // at a stall-edge attitude instead of looping; stalls still happen when the speed decays below the stall speed
    const asRad = (A.stallAlpha + (A.stallAlphaFlaps - A.stallAlpha) * flapPos) * D2R;
    // below ~1.1 x stall speed the cap eases off (nose comes down by itself instead of hanging on the edge)
    const edgeV = 1.1 * state.stallSpeed;
    const slowFrac = clamp((edgeV - V) / (0.2 * edgeV), 0, 1);
    const alphaCmd = clamp(alphaTrim + dAlphaMax * ctrl.e, -10 * D2R, asRad - (C.alphaMargin + 6 * slowFrac) * D2R);
    let qdot = C.pitchStab * t2 * (alphaCmd - alphaRad) - C.pitchDamp * t1 * qr - C.pathAssist * t2 * gamma * Math.max(eAssist, 0.5);

    const assistW = 1 - smooth01((Math.abs(ctrl.a) - 0.05) / 0.15);
    let pLevel = 0;
    if (assistW > 0 && Math.abs(rollDeg) < C.levelMaxBank) {
      pLevel = -clamp(rollRad / 1.5, -C.levelRate * D2R, C.levelRate * D2R) * assistW;
    }
    let pdot = C.rollAuth * v2 * ctrl.a - C.rollDamp * v1 * (pr - pLevel) - C.dihedral * v2 * betaRad;
    let rdot = C.yawAuth * t2 * (ctrl.r + (C.coord - C.adverse) * ctrl.a) + C.yawStab * t2 * betaRad - C.yawDamp * t1 * rr;

    let N = 0;
    if (onGround) {
      // nose wheel holds the nose down until rotate speed (the hold fades out between 24 and 30 m/s); mains keep wings level
      const pg = GR.groundPitch * D2R, pt = GR.maxPitch * D2R;
      const holdBase = GR.noseHold * (1 - smooth01((V - GR.noseHoldFadeSpeed) / 6)) + 0.5;
      const hold = holdBase * (1 - smooth01((pitchRad - pg) / (2 * D2R)));
      if (pitchRad <= pg + 0.002) {
        const net = qdot - hold;
        qdot = net > 0 ? net : (pg - pitchRad) * 80 - qr * 14;
      } else {
        qdot -= hold;
        if (pitchRad >= pt) qdot = Math.min(qdot, 0) + (pt - pitchRad) * 80 - qr * 14;
      }
      pdot = -rollRad * 60 - pr * 14 + 0.3 * pdot;
      const steer = GR.steerRate * D2R * ctrl.r * clamp((GR.steerFade - hv) / (GR.steerFade - 4), 0, 1) * clamp(hv / 2, 0, 1);
      // tyres + nose wheel dominate: aerodynamic yaw (weathervane / rudder) only counts at speed
      rdot = 8 * (steer - rr) + 0.3 * smooth01((hv - 20) / 15) * rdot;
    }

    omega.x = clamp(omega.x + qdot * h, -4, 4);
    omega.y = clamp(omega.y - rdot * h, -4, 4);
    omega.z = clamp(omega.z - pdot * h, -4, 4);
    const wl = omega.length();
    if (wl > 1e-9) { tmp.copy(omega).multiplyScalar(1 / wl); dq.setFromAxisAngle(tmp, wl * h); quat.multiply(dq).normalize(); }

    // ---- translation ----
    if (onGround) {
      groundTime += h;
      if (F.y > 0 && V > 5 && (groundTime > 0.7 || V > 35)) liftoff();
    }
    if (onGround) {
      pos.y = terrainH + P.gearHeight;
      N = Math.max(0, -F.y);
      vel.x += (F.x / mass) * h; vel.z += (F.z / mass) * h; vel.y = 0;
      // tyres: lateral velocity dies quickly, the aircraft rolls where it points
      fwdH.set(fwd.x, 0, fwd.z);
      const fh = fwdH.length();
      if (fh > 1e-6) fwdH.multiplyScalar(1 / fh); else fwdH.set(0, 0, -1);
      rightH.set(-fwdH.z, 0, fwdH.x);
      const vAlong = vel.x * fwdH.x + vel.z * fwdH.z;
      const vLat = (vel.x * rightH.x + vel.z * rightH.z) * Math.exp(-h / 0.12);
      vel.x = fwdH.x * vAlong + rightH.x * vLat; vel.z = fwdH.z * vAlong + rightH.z * vLat;
      // rolling resistance + brakes
      const paved = peers.onPaved(pos.x, pos.z);
      const mu = paved ? GR.rollResPaved : GR.rollResSoft;
      const dec = (mu * N) / mass + ((parkingBrake || brakeHeld) ? GR.brakeDecel : 0);
      const sp = Math.hypot(vel.x, vel.z);
      if (sp > 1e-6) { const dv = Math.min(sp, dec * h); vel.x -= (vel.x / sp) * dv; vel.z -= (vel.z / sp) * dv; }
      pos.x += vel.x * h; pos.z += vel.z * h;
      airTime = 0;
      if (peers.isWater(pos.x, pos.z)) { doCrash('Rolled into the water'); return; }
      if (sp > P.limits.offAirportSpeed && !onAirport(pos.x, pos.z)) { doCrash('Ran off the airport at ' + Math.round(sp * 1.943844) + ' kt'); return; }
    } else {
      vel.addScaledVector(F, h / mass);
      pos.addScaledVector(vel, h);
      airTime += h;
      const clr = wheelClearance();
      if (!armed) {
        if (clr > 0.05) armed = true;
        else if (clr < -0.05) { onGround = true; groundTime = 0; airTime = 0; takeoffPending = false; vel.y = Math.min(vel.y, 0) * 0; pos.y = terrainH + P.gearHeight; }
      } else if (clr <= 0) { contactGround(); if (crash.active) return; }
      if (takeoffPending && !onGround && airTime > 1 && vel.y > 0.3 && clr > 0.5) { takeoffPending = false; emit('takeoff', { runwayEnd: liftoffEnd }); }
    }

    // load factor along body up (ground normal force included) and stall flag
    gForce = (Fb.y + (onGround ? N * Math.max(0, up.y) : 0)) / (mass * g);
    const asDeg = A.stallAlpha + (A.stallAlphaFlaps - A.stallAlpha) * flapPos;
    stallFlag = !onGround && V > 8 && (alphaRad * R2D > asDeg - 0.5 || (V < state.stallSpeed * 0.97 && agl > 3));
  }

  // ---------------------------------------------------------------
  // Crash animation: a short tumble / slide, then frozen
  // ---------------------------------------------------------------
  function crashAnim(dt) {
    crash.t += dt;
    throttle = 0;
    rpm += (0 - rpm) * (1 - Math.exp(-dt / 0.8));
    if (crash.settled) { vel.set(0, 0, 0); return; }
    const k = Math.exp(-dt * 1.4);
    vel.x *= k; vel.z *= k;
    vel.y = Math.max(vel.y - gravity() * dt, -35);
    pos.addScaledVector(vel, dt);
    terrainH = peers.height(pos.x, pos.z);
    const floor = terrainH + params.gearHeight * 0.55;
    if (pos.y <= floor) { pos.y = floor; vel.y = 0; if (crash.t > 2.2) crash.settled = true; }
    crash.spin.multiplyScalar(Math.exp(-dt * 1.1));
    const wl = crash.spin.length();
    if (wl > 1e-4 && crash.t < 4) { tmp.copy(crash.spin).multiplyScalar(1 / wl); dq.setFromAxisAngle(tmp, wl * dt); quat.multiply(dq).normalize(); }
    omega.set(0, 0, 0);
  }

  function checkCollisions() {
    const L = params.limits;
    if (Math.abs(pos.x) > L.worldLimit || Math.abs(pos.z) > L.worldLimit) { doCrash('Left the Taipei area'); return; }
    if (!onGround && pos.y < L.buildingAlt) {
      const top = peers.obstacleTop(pos.x, pos.z);
      if (isFinite(top) && top > pos.y - 0.5) doCrash('Hit a building');
    }
  }

  // ---------------------------------------------------------------
  // Input (keyboard by event.code + mouse stick), once per frame
  // ---------------------------------------------------------------
  function deadzone(v, dz) { const a = Math.abs(v); if (a < dz) return 0; return Math.sign(v) * ((a - dz) / (1 - dz)); }
  function nextFlap(f) { return f < 0.25 ? 0.5 : f < 0.75 ? 1 : 0; }
  function readInput(dt) {
    const inp = FS.input, st = FS.settings || {};
    let e = 0, a = 0, r = 0, me = 0, ma = 0;
    brakeHeld = false;
    if (inp && inp.enabled && typeof inp.axis === 'function') {
      let pitchAxis = inp.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']); // +1 = W / Up = nose down
      if (st.invertKeyPitch) pitchAxis = -pitchAxis;
      e = -pitchAxis;
      a = inp.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
      r = inp.axis(['KeyQ'], ['KeyE']);
      const m = inp.mouse;
      if (m && m.active) {
        const sens = num(st.mouseSensitivity, 1);
        const mx = deadzone(num(m.x, 0), 0.06) * sens, my = deadzone(num(m.y, 0), 0.06) * sens;
        ma += mx;
        me += st.invertMouseY ? -my : my;   // cursor below center pulls the nose up
      }
      if (inp.isDown('ShiftLeft', 'ShiftRight', 'PageUp')) throttle += 0.5 * dt;
      if (inp.isDown('ControlLeft', 'ControlRight', 'PageDown')) throttle -= 0.5 * dt;
      if (typeof inp.wheel === 'number' && isFinite(inp.wheel)) throttle += -inp.wheel * 0.0015;
      throttle = clamp(throttle, 0, 1);
      if (inp.wasPressed('KeyF')) flapSel = nextFlap(flapSel);
      if (inp.wasPressed('KeyB')) parkingBrake = !parkingBrake;
      brakeHeld = inp.isDown('Space');
    }
    const x = api.extraInput; // optional scripted / autopilot input, summed like a second stick
    let xe = 0, xa = 0, xr = 0;
    if (x) { xe = num(x.elevator, 0); xa = num(x.aileron, 0); xr = num(x.rudder, 0); }
    cmdK.e = clamp(e, -1, 1); cmdK.a = clamp(a, -1, 1); cmdK.r = clamp(r, -1, 1);
    cmdM.e = clamp(me + xe, -1, 1); cmdM.a = clamp(ma + xa, -1, 1); cmdM.r = clamp(xr, -1, 1);
    cmd.e = clamp(cmdK.e + cmdM.e, -1, 1); cmd.a = clamp(cmdK.a + cmdM.a, -1, 1); cmd.r = clamp(cmdK.r + cmdM.r, -1, 1);
  }

  // ---------------------------------------------------------------
  // Public state / visuals
  // ---------------------------------------------------------------
  function syncState() {
    computeAxes(); computeAngles();
    const s = state;
    s.airspeed = airspeed; s.groundSpeed = Math.hypot(vel.x, vel.z);
    s.altitude = pos.y; s.terrainHeight = terrainH; s.agl = pos.y - terrainH;
    s.heading = headingDeg; s.pitch = pitchDeg; s.roll = rollDeg; s.vs = vel.y;
    s.alpha = alphaRad * R2D; s.beta = betaRad * R2D;
    s.throttle = throttle; s.rpm = rpm; s.flaps = flapSel; s.flapPos = flapPos;
    s.brakes = parkingBrake || brakeHeld; s.parkingBrake = parkingBrake;
    s.onGround = onGround; s.onRunway = peers.onRunway(pos.x, pos.z);
    s.stall = stallFlag; s.gForce = gForce;
    s.elevator = cmd.e; s.aileron = cmd.a; s.rudder = cmd.r;
    s.surfaces.elevator = ctrl.e; s.surfaces.aileron = ctrl.a; s.surfaces.rudder = ctrl.r;
    s.mouseActive = !!(FS.input && FS.input.mouse && FS.input.mouse.active);
    s.thrust = thrustN; s.lift = liftN; s.drag = dragN; s.time = simTime;
    s.stallSpeed = stallSpeed(flapPos);
    s.trimAlpha = alphaTrim * R2D;
  }

  const wheelAxis = new V3(1, 0, 0), wheelQ = new THREE.Quaternion();
  function syncVisuals(dt) {
    group.position.copy(pos); group.quaternion.copy(quat);
    if (!parts) return;
    lightTime += dt;
    const sg = parts.signs || {};
    const aDown = num(sg.aileronDown, 1), fDown = num(sg.flapDown, 1), eDown = num(sg.elevatorDown, 1), rRight = num(sg.rudderRight, 1);
    const da = ctrl.a * 20 * D2R;
    if (parts.aileronR) parts.aileronR.rotation.x = -aDown * da;   // roll right: right aileron up
    if (parts.aileronL) parts.aileronL.rotation.x = aDown * da;
    if (parts.elevator) parts.elevator.rotation.x = -eDown * ctrl.e * 25 * D2R; // nose up: trailing edge up
    if (parts.rudder) parts.rudder.rotation.y = rRight * ctrl.r * 25 * D2R;     // nose right: trailing edge right
    const df = fDown * flapPos * 30 * D2R;
    if (parts.flapL) parts.flapL.rotation.x = df;
    if (parts.flapR) parts.flapR.rotation.x = df;
    if (parts.prop) {
      parts.prop.rotation.z -= (rpm / 60) * 2 * Math.PI * dt;
      if (parts.prop.rotation.z < -1000) parts.prop.rotation.z += 1000;
      if (parts.propBlades) parts.propBlades.visible = rpm < 1300;
    }
    if (parts.propDisc) {
      const op = 0.32 * smooth01((rpm - 900) / 700);
      parts.propDisc.visible = op > 0.01;
      if (parts.propDisc.material) parts.propDisc.material.opacity = op;
    }
    const t = lightTime;
    if (parts.beacon) parts.beacon.visible = (t % 1.0) < 0.14;
    const ts = t % 1.7, strobeOn = ts < 0.06 || (ts > 0.18 && ts < 0.24);
    if (parts.strobeL) parts.strobeL.visible = strobeOn;
    if (parts.strobeR) parts.strobeR.visible = strobeOn;
    if (parts.wheels && onGround && dt > 0) {
      const gs = Math.hypot(vel.x, vel.z);
      const spin = (gs / 0.2) * dt;
      if (spin > 1e-6) {
        wheelQ.setFromAxisAngle(wheelAxis, -spin);
        for (const k of ['nose', 'mainL', 'mainR']) { const wmesh = parts.wheels[k]; if (wmesh && wmesh.quaternion) wmesh.quaternion.premultiply(wheelQ); }
      }
    }
  }

  // ---------------------------------------------------------------
  // API
  // ---------------------------------------------------------------
  function reset(opts) {
    opts = opts || {};
    try {
      updateWind();
      const x = num(opts.x, 0), z = num(opts.z, 0), heading = wrap360(num(opts.heading, 0));
      const onG = opts.onGround !== undefined ? !!opts.onGround : !(num(opts.altitude, -1) > 0);
      terrainH = peers.height(x, z);
      throttle = clamp(num(opts.throttle, onG ? 0 : 0.6), 0, 1);
      rpm = params.rpm.idle + (params.rpm.max - params.rpm.idle) * throttle;
      const f = num(opts.flaps, 0);
      flapSel = f < 0.25 ? 0 : f < 0.75 ? 0.5 : 1; flapPos = flapSel;
      const speed = Math.max(0, num(opts.speed, 0));
      const dir = FS.geo ? FS.geo.headingToDir(heading) : { x: Math.sin(heading * D2R), z: -Math.cos(heading * D2R) };
      pos.set(x, onG ? terrainH + params.gearHeight : Math.max(num(opts.altitude, terrainH + 500), terrainH + params.gearHeight + 1), z);
      vel.set(dir.x * speed, 0, dir.z * speed);
      setAttitude(heading, onG ? params.ground.groundPitch : levelPitchFor(speed, flapSel), 0);
      omega.set(0, 0, 0);
      ctrl.e = ctrl.a = ctrl.r = 0; cmd.e = cmd.a = cmd.r = 0;
      cmdK.e = cmdK.a = cmdK.r = 0; cmdM.e = cmdM.a = cmdM.r = 0; ctrlK.e = ctrlK.a = ctrlK.r = 0; ctrlM.e = ctrlM.a = ctrlM.r = 0;
      alphaTrim = onG ? 0 : levelAlphaRad(Math.max(speed, 15), flapSel, num(FS.CONFIG && FS.CONFIG.rho, 1.225));
      contactSuppress = 0;
      parkingBrake = false; brakeHeld = false;
      onGround = onG; airTime = 0; groundTime = onG ? 10 : 0; armed = false; takeoffPending = false; liftoffEnd = null;
      crash.active = false; crash.t = 0; crash.settled = false;
      state.crashed = false; state.crashReason = '';
      stallFlag = false; alphaRad = 0; betaRad = 0; gForce = 1; thrustN = 0; liftN = 0; dragN = 0;
      airspeed = tmp.copy(vel).sub(wind).length();
      simTime = 0;
      syncState(); syncVisuals(0);
    } catch (e) { warnOnce('reset failed', e); }
    emit('reset', {});
  }

  function update(dt) {
    try {
      if (!(dt > 0) || !isFinite(dt)) return;
      dt = Math.min(dt, 0.1);
      if (!initialized) { updateWind(); initialized = true; }
      if (crash.active) { crashAnim(dt); syncState(); syncVisuals(dt); return; }
      simTime += dt;
      readInput(dt);
      snap.pos.copy(pos); snap.vel.copy(vel); snap.quat.copy(quat); snap.omega.copy(omega);
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / n;
      for (let i = 0; i < n; i++) { step(h); if (crash.active) break; }
      const sum = pos.x + pos.y + pos.z + vel.x + vel.y + vel.z + quat.x + quat.y + quat.z + quat.w + omega.x + omega.y + omega.z;
      if (!isFinite(sum)) {
        warnOnce('non-finite state, restoring last good frame');
        pos.copy(snap.pos); vel.copy(snap.vel); quat.copy(snap.quat).normalize(); omega.set(0, 0, 0);
      }
      if (!crash.active) checkCollisions();
      syncState(); syncVisuals(dt);
    } catch (e) { warnOnce('update failed', e); }
  }

  function init(scene) {
    try {
      const built = buildAircraftModel(FS, THREE);
      modelGroup = built.group; parts = built.parts || null;
    } catch (e) {
      warnOnce('model build failed, using an empty placeholder', e);
      modelGroup = new THREE.Group(); parts = null;
    }
    group.name = 'aircraft';
    modelGroup.name = 'aircraft-model';
    group.add(modelGroup);
    if (scene && typeof scene.add === 'function') scene.add(group);
    api.parts = parts; api.model = modelGroup;
    reset({ x: 0, z: 0, heading: 0, onGround: true, speed: 0, throttle: 0, flaps: 0 });
    initialized = true;
  }

  const api = (FS.aircraft = {
    init, reset, update, state, params,
    group, parts: null, model: null,
    eyePoint: new V3(0, 0.75, -0.55),
    chaseOffset: new V3(0, 4.5, 17),
    setThrottle(v) { throttle = clamp(num(v, throttle), 0, 1); },
    setFlaps(v) { const f = num(v, 0); flapSel = f < 0.25 ? 0 : f < 0.75 ? 0.5 : 1; },
    setBrakes(b) { parkingBrake = !!b; },
    setAttitude(heading, pitch, roll) { setAttitude(num(heading, 0), num(pitch, 0), num(roll, 0)); syncState(); syncVisuals(0); },
    extraInput: null, // { elevator, aileron, rudder } added to the pilot's inputs (tests, autopilots)
    // curves exposed for tests / HUD
    liftCoef: (alphaDeg, flap) => { const a = alphaDeg * D2R; return liftCoef(a, flap || 0, stallBlend(a, flap || 0)); },
    stallSpeed,
  });

  // ---- BEGIN MODEL ----
  // Cessna 172 "B-15821" built from primitives + lofted hulls. Group origin = CG, forward -Z, wheel bottoms at y = -0.9.
  // Returned parts: prop (spin: rotation.z), propBlades (hide at high rpm), propDisc (translucent, opacity animated),
  //   aileronL/R, flapL/R, elevator (pivot groups; rotation.x, +1 = trailing edge DOWN), rudder (rotation.y, +1 = trailing
  //   edge RIGHT), navL/navR/navTail/beacon/strobeL/strobeR (toggle .visible), wheels {nose, mainL, mainR} (meshes inside
  //   unrotated pivot groups at the axles; spin by pre-multiplying the mesh quaternion about the parent's X axis),
  //   signs { aileronDown: 1, flapDown: 1, elevatorDown: 1, rudderRight: 1 }.
  function buildAircraftModel(FS, THREE) {
    const D2R = Math.PI / 180;
    const group = new THREE.Group();
    const V3 = THREE.Vector3;
    const std = (hex, rough, metal, extra) => new THREE.MeshStandardMaterial(Object.assign({ color: FS.color(hex), roughness: rough == null ? 0.5 : rough, metalness: metal == null ? 0.1 : metal }, extra || {}));
    const matWhite = std('#f4f5f2');
    const matGlass = new THREE.MeshStandardMaterial({ color: FS.color('#1c2a3a'), roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    const matTire = std('#2a2a2a', 0.9, 0);
    const matHub = std('#b9bcc0', 0.4, 0.5);
    const matDark = std('#3a3a3a', 0.6, 0.2);
    const matInterior = std('#20242a', 0.9, 0);
    const matSeat = std('#334a66', 0.85, 0);
    const matStrut = std('#d9dad6', 0.45, 0.3);
    const matBlue = std('#1f4e9c', 0.5, 0.1);

    // ---------- canvas textures (guarded: Node / headless has no document) ----------
    let hullMat = matWhite, decalMat = null;
    try {
      if (typeof document !== 'undefined' && document.createElement && FS.textureFromCanvas) {
        // fuselage livery: u = nose -> tail, v around the section (0 = belly, 0.25 = right side, 0.5 = top, 0.75 = left side)
        const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
        const ctx = c.getContext('2d');
        if (ctx) {
          const W = c.width, H = c.height, row = (v) => (1 - v) * H;
          ctx.fillStyle = '#f4f5f2'; ctx.fillRect(0, 0, W, H);
          const stripe = (vSide, up, color, width, offset) => {
            // band along the side that sweeps toward the top (v 0.5) over the rear fuselage
            const y0 = row(vSide) + offset * up, y1 = row(vSide + up * 0.17) + offset * up;
            ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(W * 0.1, y0); ctx.lineTo(W * 0.66, y0);
            ctx.quadraticCurveTo(W * 0.8, y0, W * 0.9, y1); ctx.lineTo(W * 0.985, y1); ctx.stroke();
          };
          for (const [vSide, up] of [[0.25, 1], [0.75, -1]]) {
            stripe(vSide, up, '#1f4e9c', 22, -2);
            stripe(vSide, up, '#d5a83a', 6, 20);
            stripe(vSide, up, '#1f4e9c', 3, 30);
          }
          // anti-glare panel on top of the cowling
          ctx.fillStyle = '#2b2f36'; ctx.fillRect(0, row(0.5) - 34, W * 0.135, 68);
          // registration on the rear fuselage sides (mirrored on the right side so it reads nose-forward)
          ctx.fillStyle = '#163a75'; ctx.font = 'bold 42px sans-serif'; ctx.textBaseline = 'middle';
          ctx.textAlign = 'center';
          ctx.fillText('B-15821', W * 0.835, row(0.75) + 62);
          ctx.save(); ctx.translate(W * 0.835, row(0.25) - 62); ctx.scale(-1, 1); ctx.fillText('B-15821', 0, 0); ctx.restore();
          const tex = FS.textureFromCanvas(c);
          hullMat = std('#ffffff', 0.5, 0.1, { map: tex });
        }
        const d = document.createElement('canvas'); d.width = 512; d.height = 256;
        const dctx = d.getContext('2d');
        if (dctx) {
          dctx.clearRect(0, 0, 512, 256);
          dctx.fillStyle = '#163a75'; dctx.font = 'bold 118px sans-serif'; dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
          dctx.fillText('B-15821', 256, 132);
          const dtex = FS.textureFromCanvas(d);
          decalMat = new THREE.MeshStandardMaterial({ map: dtex, transparent: true, roughness: 0.6, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        }
      }
    } catch (e) { hullMat = matWhite; decalMat = null; }

    // ---------- geometry helpers ----------
    // loft: closed outlines (arrays of [x,y,z], equal length) -> smooth-shaded hull with end caps and (u along, v around) UVs
    function loft(outlines, capStart, capEnd) {
      const n = outlines[0].length, m = outlines.length, stride = n + 1;
      const pos = [], uv = [], idx = [];
      for (let i = 0; i < m; i++) {
        const o = outlines[i];
        for (let j = 0; j <= n; j++) { const p = o[j % n]; pos.push(p[0], p[1], p[2]); uv.push(i / (m - 1), j / n); }
      }
      for (let i = 0; i < m - 1; i++) for (let j = 0; j < n; j++) {
        const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      const cap = (o, flip) => {
        const base = pos.length / 3;
        let cx = 0, cy = 0, cz = 0;
        for (const p of o) { cx += p[0]; cy += p[1]; cz += p[2]; }
        cx /= n; cy /= n; cz /= n;
        pos.push(cx, cy, cz); uv.push(0.5, 0.5);
        for (const p of o) { pos.push(p[0], p[1], p[2]); uv.push(0.5, 0.5); }
        for (let j = 0; j < n; j++) { const a = base + 1 + j, b = base + 1 + ((j + 1) % n); if (flip) idx.push(base, b, a); else idx.push(base, a, b); }
      };
      if (capStart) cap(outlines[0], false);
      if (capEnd) cap(outlines[m - 1], true);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      // make the winding outward (signed volume test), then smooth normals
      const P = g.attributes.position.array, I = g.index.array;
      let vol = 0;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
        vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      }
      if (vol < 0) for (let t = 0; t < I.length; t += 3) { const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp; }
      g.computeVertexNormals();
      return g;
    }
    // rounded-rectangle (superellipse) fuselage section, starting at the belly and going around via the right side
    function section(z, cy, w, h, n, e) {
      const pts = [];
      for (let k = 0; k < n; k++) {
        const th = -Math.PI / 2 + (k / n) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
        pts.push([(w / 2) * Math.sign(c) * Math.pow(Math.abs(c), 2 / e), cy + (h / 2) * Math.sign(s) * Math.pow(Math.abs(s), 2 / e), z]);
      }
      return pts;
    }
    // airfoil outline in (chordwise, thickness) with the rear cut at chord fraction cf (1 = full airfoil), n points, cosine spaced
    function airfoil(c, cf, tRatio, n, camber) {
      const half = n / 2, out = [];
      const yt = (x) => 5 * tRatio * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
      const yc = (x) => camber * 4 * x * (1 - x);
      for (let i = 0; i < half; i++) { const x = cf * (1 - Math.cos((Math.PI / 2) * (i / (half - 1)))); out.push([x * c, (yc(x) + yt(x)) * c]); }
      for (let i = half - 1; i >= 0; i--) { const x = cf * (1 - Math.cos((Math.PI / 2) * (i / (half - 1)))); out.push([x * c, (yc(x) - yt(x)) * c]); }
      // reverse so the upper surface runs rear -> leading edge, then lower surface leading edge -> rear
      return out.reverse();
    }
    // wedge (control surface) outline: hinge thickness th tapering to the trailing edge
    function wedge(chord, th) { return [[0, th / 2], [chord, 0.006], [chord, -0.006], [0, -th / 2]]; }
    const mesh = (geom, mat, name, shadow) => {
      const mm = new THREE.Mesh(geom, mat); mm.name = name || '';
      if (shadow !== false) { mm.castShadow = true; }
      return mm;
    };
    const quad = (a, b, c, d, mat, name) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.computeVertexNormals();
      const mm = new THREE.Mesh(g, mat); mm.name = name || ''; return mm;
    };
    const tri = (a, b, c, mat, name) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
      g.computeVertexNormals();
      const mm = new THREE.Mesh(g, mat); mm.name = name || ''; return mm;
    };
    const UP = new V3(0, 1, 0), tmpDir = new V3();
    // box bar between two points (w across, d deep), or a round tube when d is null
    function bar(p1, p2, w, d, mat, name) {
      const a = new V3(...p1), b = new V3(...p2), len = a.distanceTo(b);
      const geom = d == null ? new THREE.CylinderGeometry(w, w, len, 10) : new THREE.BoxGeometry(w, len, d);
      const mm = mesh(geom, mat, name);
      mm.position.copy(a).add(b).multiplyScalar(0.5);
      mm.quaternion.setFromUnitVectors(UP, tmpDir.copy(b).sub(a).normalize());
      return mm;
    }
    const light = (hex, r, name) => { const mm = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color: FS.color(hex), toneMapped: false })); mm.name = name; return mm; };

    // ---------- fuselage hull ----------
    const N = 18, E = 3.2;
    const hull = mesh(loft([
      section(-2.42, 0.13, 0.56, 0.5, N, 2.4),
      section(-2.1, 0.14, 0.84, 0.74, N, 2.8),
      section(-1.6, 0.03, 1.02, 0.84, N, E),
      section(-1.3, 0.02, 1.12, 0.86, N, E),
      section(-0.75, 0.0, 1.18, 0.9, N, E),
      section(0.95, 0.0, 1.16, 0.9, N, E),
      section(1.75, 0.17, 0.82, 0.72, N, E),
      section(2.8, 0.3, 0.56, 0.56, N, 2.6),
      section(4.0, 0.4, 0.36, 0.4, N, 2.4),
      section(5.2, 0.45, 0.2, 0.26, N, 2.2),
    ], true, true), hullMat, 'fuselage');
    hull.receiveShadow = true;
    group.add(hull);
    // air intake under the spinner + exhaust stubs
    const intake = mesh(new THREE.BoxGeometry(0.34, 0.1, 0.16), matInterior, 'intake', false); intake.position.set(0, -0.05, -2.42); group.add(intake);
    for (const sx of [-1, 1]) { const ex = mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.22, 8), matDark, 'exhaust', false); ex.position.set(sx * 0.3, -0.44, -1.55); ex.rotation.x = 1.2; group.add(ex); }

    // ---------- cabin: roof, windscreen, pillars, windows, rear fairing, interior ----------
    const roof = mesh(new THREE.BoxGeometry(1.14, 0.1, 1.75), matWhite, 'roof'); roof.position.set(0, 1.05, 0.125); roof.receiveShadow = true; group.add(roof);
    const windscreen = quad([-0.56, 0.45, -1.3], [0.56, 0.45, -1.3], [0.55, 1.0, -0.75], [-0.55, 1.0, -0.75], matGlass, 'windscreen'); group.add(windscreen);
    for (const sx of [-1, 1]) {
      group.add(bar([sx * 0.56, 0.45, -1.3], [sx * 0.55, 1.0, -0.75], 0.06, 0.07, matWhite, 'pillarA'));
      group.add(bar([sx * 0.585, 0.45, 0.3], [sx * 0.575, 1.0, 0.3], 0.06, 0.07, matWhite, 'pillarB'));
      group.add(quad([sx * 0.59, 0.47, -0.72], [sx * 0.59, 0.47, 0.27], [sx * 0.575, 1.0, 0.27], [sx * 0.575, 1.0, -0.72], matGlass, 'doorWindow'));
      group.add(quad([sx * 0.59, 0.47, 0.33], [sx * 0.585, 0.47, 0.98], [sx * 0.565, 1.0, 0.98], [sx * 0.575, 1.0, 0.33], matGlass, 'rearSideWindow'));
      const fair = tri([sx * 0.58, 0.45, 0.98], [sx * 0.55, 1.0, 0.98], [sx * 0.41, 0.53, 1.75], matWhite, 'rearFairing'); fair.material = std('#f4f5f2', 0.5, 0.1, { side: THREE.DoubleSide }); group.add(fair);
      const door = quad([sx * 0.595, -0.38, -0.72], [sx * 0.595, -0.38, 0.27], [sx * 0.595, 0.44, 0.27], [sx * 0.595, 0.44, -0.72], matBlue, 'doorLine'); door.visible = false; group.add(door);
    }
    group.add(quad([-0.55, 1.0, 1.0], [0.55, 1.0, 1.0], [0.4, 0.53, 1.72], [-0.4, 0.53, 1.72], matGlass, 'rearWindow'));
    const floor = mesh(new THREE.BoxGeometry(1.1, 0.04, 2.2), matInterior, 'floor', false); floor.position.set(0, -0.36, -0.1); group.add(floor);
    const panel = mesh(new THREE.BoxGeometry(1.06, 0.3, 0.2), matInterior, 'panel', false); panel.position.set(0, 0.3, -1.15); group.add(panel);
    const glare = mesh(new THREE.BoxGeometry(1.08, 0.03, 0.34), matInterior, 'glareShield', false); glare.position.set(0, 0.44, -1.1); group.add(glare);
    for (const sx of [-1, 1]) {
      const cushion = mesh(new THREE.BoxGeometry(0.44, 0.12, 0.45), matSeat, 'seat', false); cushion.position.set(sx * 0.3, -0.06, 0.05); group.add(cushion);
      const back = mesh(new THREE.BoxGeometry(0.44, 0.52, 0.1), matSeat, 'seatBack', false); back.position.set(sx * 0.3, 0.22, 0.32); group.add(back);
      const yoke = mesh(new THREE.TorusGeometry(0.1, 0.014, 6, 16, Math.PI), matDark, 'yoke', false); yoke.position.set(sx * 0.3, 0.3, -0.98); yoke.rotation.z = Math.PI; group.add(yoke);
    }

    // ---------- wings ----------
    const WING_Y = 1.185, T = 0.115, CAMB = 0.02;
    const wingSection = (x, chord, z0, cf, ts) => airfoil(chord, cf, T * ts, 16, CAMB).map((p) => [x, p[1], z0 + p[0]]);
    const parts = { signs: { aileronDown: 1, flapDown: 1, elevatorDown: 1, rudderRight: 1 } };
    const wings = {};
    for (const side of [1, -1]) {
      const wg = new THREE.Group(); wg.name = side > 0 ? 'wingR' : 'wingL';
      wg.position.set(0, WING_Y, 0);
      wg.rotation.z = side * 1.7 * D2R;
      const S = (x, chord, z0, cf, ts) => wingSection(side * x, chord, z0, cf, ts);
      const wing = mesh(loft([
        S(0.0, 1.5, -1.25, 1, 1), S(0.66, 1.5, -1.25, 1, 1),
        S(0.7, 1.5, -1.25, 0.72, 1), S(2.84, 1.5, -1.25, 0.72, 1),
        S(2.88, 1.5, -1.25, 0.75, 1), S(5.1, 1.5, -1.25, 0.75, 1),
        S(5.16, 1.5, -1.25, 1, 0.95), S(5.35, 1.2, -1.15, 1, 0.6), S(5.5, 0.7, -0.95, 1, 0.3),
      ], true, true), matWhite, wg.name + 'Panel');
      wing.receiveShadow = true;
      wg.add(wing);
      // flap: x 0.72..2.84, hinge at 72 % chord (z -0.17), chord 0.42
      const flapPivot = new THREE.Group(); flapPivot.name = side > 0 ? 'flapR' : 'flapL';
      flapPivot.position.set(0, 0, -0.17);
      const flapGeom = loft([wedge(0.42, 0.095).map((p) => [side * 0.72, p[1], p[0]]), wedge(0.42, 0.095).map((p) => [side * 2.84, p[1], p[0]])], true, true);
      flapPivot.add(mesh(flapGeom, matWhite, 'flapSurface'));
      wg.add(flapPivot);
      // aileron: x 2.9..5.1, hinge at 75 % chord (z -0.125), chord 0.375
      const ailPivot = new THREE.Group(); ailPivot.name = side > 0 ? 'aileronR' : 'aileronL';
      ailPivot.position.set(0, 0, -0.125);
      const ailGeom = loft([wedge(0.375, 0.09).map((p) => [side * 2.9, p[1], p[0]]), wedge(0.375, 0.09).map((p) => [side * 5.1, p[1], p[0]])], true, true);
      ailPivot.add(mesh(ailGeom, matWhite, 'aileronSurface'));
      wg.add(ailPivot);
      // tip lights (nav + strobe)
      const nav = light(side > 0 ? '#2aff5a' : '#ff2a2a', 0.06, side > 0 ? 'navR' : 'navL'); nav.position.set(side * 5.47, 0.0, -0.6); wg.add(nav);
      const strobe = light('#ffffff', 0.06, side > 0 ? 'strobeR' : 'strobeL'); strobe.position.set(side * 5.47, 0.0, -0.42); wg.add(strobe);
      group.add(wg);
      wings[side] = wg;
      if (side > 0) { parts.flapR = flapPivot; parts.aileronR = ailPivot; parts.navR = nav; parts.strobeR = strobe; }
      else { parts.flapL = flapPivot; parts.aileronL = ailPivot; parts.navL = nav; parts.strobeL = strobe; }
      // lift strut from the wing underside to the lower fuselage
      const tipY = WING_Y + 2.4 * Math.tan(1.7 * D2R);
      group.add(bar([side * 2.4, tipY - 0.06, -0.55], [side * 0.57, -0.3, -0.95], 0.05, 0.11, matStrut, 'strut'));
      group.add(bar([side * 2.4, tipY - 0.06, -0.55], [side * 1.6, tipY - 0.55, -0.72], 0.025, null, matStrut, 'jury'));
    }

    // ---------- empennage ----------
    const stabSection = (x, chord, z0, cf) => airfoil(chord, cf, 0.1, 12, 0).map((p) => [x, 0.3 + p[1], z0 + p[0]]);
    const stab = mesh(loft([stabSection(-1.7, 0.75, 4.6, 0.56), stabSection(-0.4, 0.95, 4.45, 0.56), stabSection(0.4, 0.95, 4.45, 0.56), stabSection(1.7, 0.75, 4.6, 0.56)], true, true), matWhite, 'stabilizer');
    stab.receiveShadow = true; group.add(stab);
    const elevPivot = new THREE.Group(); elevPivot.name = 'elevator'; elevPivot.position.set(0, 0.3, 4.99);
    elevPivot.add(mesh(loft([
      wedge(0.33, 0.06).map((p) => [-1.68, p[1], p[0] + 0.03]), wedge(0.42, 0.07).map((p) => [-0.4, p[1], p[0] - 0.01]),
      wedge(0.42, 0.07).map((p) => [0.4, p[1], p[0] - 0.01]), wedge(0.33, 0.06).map((p) => [1.68, p[1], p[0] + 0.03]),
    ], true, true), matWhite, 'elevatorSurface'));
    group.add(elevPivot);
    // vertical fin (swept) with a dorsal fillet; outline sections lie in horizontal planes
    const finSection = (y, chord, z0, cf, th) => airfoil(chord, cf, th, 12, 0).map((p) => [p[1], y, z0 + p[0]]);
    const fin = mesh(loft([finSection(0.45, 1.2, 3.85, 1, 0.11), finSection(0.95, 0.95, 4.15, 1, 0.1), finSection(1.45, 0.62, 4.55, 1, 0.09), finSection(1.82, 0.32, 4.85, 1, 0.08)], true, true), matWhite, 'fin');
    group.add(fin);
    const dorsal = mesh(loft([[[-0.03, 0.4, 3.0], [0.03, 0.4, 3.0], [0, 0.44, 3.0]], [[-0.07, 0.42, 3.9], [0.07, 0.42, 3.9], [0, 0.78, 3.9]]], true, true), matWhite, 'dorsal');
    group.add(dorsal);
    const rudPivot = new THREE.Group(); rudPivot.name = 'rudder'; rudPivot.position.set(0, 0, 5.06);
    rudPivot.add(mesh(loft([
      wedge(0.5, 0.1).map((p) => [p[1], 0.42, p[0] - 0.02]), wedge(0.44, 0.09).map((p) => [p[1], 1.0, p[0] + 0.03]),
      wedge(0.36, 0.07).map((p) => [p[1], 1.5, p[0] + 0.07]), wedge(0.3, 0.06).map((p) => [p[1], 1.85, p[0] + 0.1]),
    ], true, true), matWhite, 'rudderSurface'));
    const navTail = light('#ffffff', 0.05, 'navTail'); navTail.position.set(0, 1.83, 0.42); rudPivot.add(navTail);
    group.add(rudPivot);
    const beacon = light('#ff2a2a', 0.08, 'beacon'); beacon.position.set(0, 1.86, 4.97); group.add(beacon);
    // registration decals on both sides of the fin
    if (decalMat) {
      for (const sx of [-1, 1]) {
        const dec = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.33), decalMat); dec.name = 'registration';
        dec.position.set(sx * 0.052, 1.12, 4.7); dec.rotation.y = sx * Math.PI / 2; group.add(dec);
      }
    }

    // ---------- landing gear ----------
    const wheel = (r, w, name) => { const mm = mesh(new THREE.CylinderGeometry(r, r, w, 20), matTire, name); mm.rotation.z = Math.PI / 2;
      const hub = mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w + 0.02, 12), matHub, 'hub', false); mm.add(hub); return mm; };
    const fairing = (x, y, z, r, sy, sz) => { const mm = mesh(new THREE.SphereGeometry(r, 16, 12), matWhite, 'fairing'); mm.position.set(x, y, z); mm.scale.set(0.62, sy, sz); return mm; };
    parts.wheels = {};
    const nosePivot = new THREE.Group(); nosePivot.name = 'noseGear'; nosePivot.position.set(0, -0.73, -1.6);
    const noseWheel = wheel(0.17, 0.12, 'noseWheel'); nosePivot.add(noseWheel); group.add(nosePivot); parts.wheels.nose = noseWheel;
    group.add(bar([0, -0.4, -1.63], [0, -0.66, -1.6], 0.035, null, matStrut, 'noseStrut'));
    group.add(fairing(0, -0.6, -1.6, 0.25, 0.76, 1.5));
    for (const sx of [-1, 1]) {
      const piv = new THREE.Group(); piv.name = sx > 0 ? 'mainGearR' : 'mainGearL'; piv.position.set(sx * 1.1, -0.7, 0.3);
      const wm = wheel(0.2, 0.14, sx > 0 ? 'mainWheelR' : 'mainWheelL'); piv.add(wm); group.add(piv);
      if (sx > 0) parts.wheels.mainR = wm; else parts.wheels.mainL = wm;
      group.add(bar([sx * 0.5, -0.4, 0.3], [sx * 1.04, -0.66, 0.3], 0.045, 0.13, matStrut, 'mainLeg'));
      group.add(fairing(sx * 1.1, -0.58, 0.3, 0.27, 0.78, 1.55));
    }

    // ---------- propeller ----------
    const prop = new THREE.Group(); prop.name = 'prop'; prop.position.set(0, 0.15, -2.5);
    const spinner = mesh(new THREE.ConeGeometry(0.16, 0.28, 16), matWhite, 'spinner'); spinner.rotation.x = -Math.PI / 2; spinner.position.z = -0.12; prop.add(spinner);
    const propBlades = new THREE.Group(); propBlades.name = 'propBlades';
    const hub = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 12), matDark, 'propHub', false); hub.rotation.x = Math.PI / 2; hub.position.z = 0.04; propBlades.add(hub);
    for (let i = 0; i < 2; i++) {
      const bg = new THREE.Group(); bg.rotation.z = i * Math.PI;
      const blade = mesh(new THREE.BoxGeometry(0.1, 0.9, 0.02), matDark, 'blade'); blade.position.y = 0.5; blade.rotation.y = 0.35; bg.add(blade);
      const tip = mesh(new THREE.BoxGeometry(0.102, 0.08, 0.022), std('#e8c437', 0.6, 0), 'bladeTip', false); tip.position.y = 0.9; tip.rotation.y = 0.35; bg.add(tip);
      propBlades.add(bg);
    }
    prop.add(propBlades);
    group.add(prop);
    const propDisc = new THREE.Mesh(new THREE.CircleGeometry(0.95, 40), new THREE.MeshBasicMaterial({ color: FS.color('#9aa0a6'), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    propDisc.name = 'propDisc'; propDisc.position.set(0, 0.15, -2.5); propDisc.visible = false; group.add(propDisc);

    Object.assign(parts, { prop, propBlades, propDisc, elevator: elevPivot, rudder: rudPivot, navTail, beacon });
    group.traverse((o) => { if (o.isMesh && o.castShadow && (o.name === 'fuselage' || /Panel$/.test(o.name) || o.name === 'stabilizer')) o.receiveShadow = true; });
    return { group, parts };
  }
  // ---- END MODEL ----
})();
