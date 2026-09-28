/* ============================================================
   Taipei Skies — js/nav.js
   Landing / takeoff guidance and the minimap. Exports FS.nav only:
     init(scene), setTarget(end|null), target, setPhase(p), phase,
     autoTarget(), cycleTarget(), gatesEnabled, update(dt), guidance,
     drawMinimap(canvas, rangeMeters)
   Hotkeys (only while FS.input.enabled): L cycle landing target (runway
   ends, nearest first), N toggle guidance gates.

   Guidance model, per target runway end E (landing direction E.dir):
     dist       m to go to the threshold along E.dir (+ while short of it)
     crossTrack m right of the extended centerline, facing along E.dir
     locDev     atan2(-crossTrack, max(dist, 1000)) deg; + = runway is to
                your right -> fly right. (Contract: atan2(-ct, dist); the
                denominator is clamped at 1 km so the needle stays usable
                through the flare and rollout instead of pegging.)
     desiredAlt E.elev + 15 m + max(dist, 0) * tan 3deg  (3 deg glideslope,
                15 m threshold-crossing height, touchdown zone = thr + 300 m)
     gsDev      atan2(altitude - desiredAlt, max(dist, 300)) deg; + = above
     onFinal    dist < 14 km, |locDev| < 12, heading within 45 deg of E.heading
                (once on final: 15 / 50 deg before it drops out — hysteresis)
     established onFinal and |locDev| < 1.5 and |gsDev| < 0.7
   Steer-to plan when not on final: IAF (10 km out on the centerline, on the
   glidepath) when >= 10 km out; a ~35 deg intercept point on the centerline
   when inside the approach cone; otherwise a downwind point DW (6 km out,
   3 km abeam on the aircraft's side) -> IAF -> threshold, so the plan never
   routes through the runway backwards. On final desiredHeading = E.heading +
   clamp(-crossTrack * gain, -30, 30) with gain 0.05 deg/m beyond ~4.6 km
   rising to 0.15 deg/m inside ~1.5 km.

   Additions beyond CONTRACT.md (all optional for consumers):
     guidance.landed, .rolledOut, .wpDist, .mode, .phaseTime, .agl
     guidance.gates.missed / .index / .set ('approach' | 'departure')
     events 'gateMissed' {index,total,set}, 'targetChanged' {end},
            'phaseChanged' {phase, prev}
     landing -> takeoff on a touch-and-go (fresh departure rings ahead);
     in 'free' the target auto-switches to a runway end the aircraft is
     lined up with, unless the pilot picked one with L.
   ============================================================ */
(function () {
  'use strict';
  const FS = (window.FS = window.FS || {});
  const G = FS.geo, U = FS.units;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // Tunables --------------------------------------------------------
  const GS_DEG = 3, TCH = 15, TAN_GS = Math.tan(GS_DEG * D2R);
  const IAF_DIST = 10000, DW_DIST = 6000, DW_OFFSET = 3000, DW_CAPTURE = 900;
  const GATE_FAR = 9000, GATE_NEAR = 600, GATE_STEP = 700, GATE_R_FAR = 36, GATE_R_NEAR = 22;
  const DEP_FROM = 1500, DEP_TO = 6000, DEP_COUNT = 6, DEP_RADIUS = 40, DEP_GRADIENT = 0.07, DEP_BASE = 80;
  const CLIMB_ABOVE_FIELD = 457.2;   // 1,500 ft
  const MIN_DWELL = 2;               // s between automatic phase changes
  const PHASES = ['takeoff', 'landing', 'free'];

  // State -----------------------------------------------------------
  let scene = null;
  let approachSet = null, departureSet = null;
  let minimap = null, lastPlan = null;
  let time = 0, phaseTime = 0, retargetTime = 0;
  let userPinned = false, dwReached = false, lastMode = null, wasOnFinal = false;
  let landed = false, rolledOut = false;
  let COL = null;
  const warned = new Set();

  const nav = (FS.nav = {
    target: null,
    phase: 'free',
    gatesEnabled: true,
    guidance: null,
    init, setTarget, setPhase, autoTarget, cycleTarget, update, drawMinimap,
  });

  const guidance = (nav.guidance = {
    target: null, phase: 'free', dist: 0, bearing: 0, alongTrack: 0, crossTrack: 0,
    locDev: 0, gsDev: 0, desiredAlt: 0, altError: 0, desiredHeading: 0, headingError: 0,
    onFinal: false, established: false, wp: null, wpDist: 0, mode: 'none',
    gates: { total: 0, passed: 0, missed: 0, next: null, index: -1, set: null },
    instruction: 'Free flight · press L to pick a runway', speedCue: 60, papi: 'RRRR',
    landed: false, rolledOut: false, phaseTime: 0, agl: 0,
  });

  // Helpers ---------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function warnOnce(key, e) { if (warned.has(key)) return; warned.add(key); console.warn('[nav] ' + key, e || ''); }
  function thousands(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtFt(m) { return thousands(Math.round((m || 0) * U.M_TO_FT / 10) * 10) + ' ft'; }
  function fmtKt(ms, step) { step = step || 1; return Math.round((ms || 0) * U.MS_TO_KT / step) * step + ' kt'; }
  function fmtNm(m) { return (Math.max(0, m || 0) * U.M_TO_NM).toFixed(1) + ' nm'; }
  function fmtHdg(h) { let v = Math.round(G.wrap360(h || 0)) % 360; if (v === 0) v = 360; return String(v).padStart(3, '0') + '°'; }
  function ends() {
    try { const a = FS.airports && FS.airports.getRunwayEnds && FS.airports.getRunwayEnds(); return Array.isArray(a) ? a : []; }
    catch (e) { warnOnce('getRunwayEnds', e); return []; }
  }
  function validEnd(E) { return !!(E && E.dir && E.threshold && typeof E.heading === 'number'); }
  function state() { const a = FS.aircraft; return a && a.state && a.state.pos ? a.state : null; }
  function altOf(s) { return typeof s.altitude === 'number' ? s.altitude : s.pos.y; }
  function groundHeight(x, z) { try { const w = FS.world; return w && w.getHeight ? (w.getHeight(x, z) || 0) : 0; } catch (e) { return 0; } }
  function vSpeeds() {
    const p = FS.aircraft && FS.aircraft.params && FS.aircraft.params.vSpeeds;
    return Object.assign({ rotate: 28, approach: 33, stall: 24, stallFlaps: 21, cruise: 60, never: 82 }, p || {});
  }
  function showMessage(text, ms) { try { if (FS.hud && FS.hud.showMessage) FS.hud.showMessage(text, ms || 1500); } catch (e) { /* ignore */ } }
  function emit(name, data) { try { if (FS.events && FS.events.emit) FS.events.emit(name, data); } catch (e) { /* ignore */ } }
  function perpRight(dir) { return { x: -dir.z, z: dir.x }; }
  function tdzOf(E) { return E.tdz || { x: E.threshold.x + E.dir.x * 300, z: E.threshold.z + E.dir.z * 300 }; }
  function centerOf(E) { return E.center || { x: E.threshold.x + E.dir.x * (E.length || 2000) / 2, z: E.threshold.z + E.dir.z * (E.length || 2000) / 2 }; }
  function elevOf(E) { return typeof E.elev === 'number' ? E.elev : 0; }
  function desiredAltAt(E, dist) { return elevOf(E) + TCH + Math.max(dist, 0) * TAN_GS; }
  function climbTargetAlt(E) { return Math.round((elevOf(E) + CLIMB_ABOVE_FIELD) * U.M_TO_FT / 100) * 100 * U.FT_TO_M; }
  function colors() {
    if (!COL) COL = { cyan: FS.color('#35d6ff'), green: FS.color('#5bff8a'), amber: FS.color('#ffb347'), white: FS.color('#ffffff') };
    return COL;
  }

  // Geometry --------------------------------------------------------
  function computeGeometry(E, s) {
    const pos = s.pos, alt = altOf(s), dir = E.dir, thr = E.threshold, tdz = tdzOf(E);
    const along = G.alongTrack(pos.x, pos.z, tdz.x, tdz.z, dir.x, dir.z);
    const dist = -G.alongTrack(pos.x, pos.z, thr.x, thr.z, dir.x, dir.z);
    const crossTrack = G.crossTrack(pos.x, pos.z, thr.x, thr.z, dir.x, dir.z);
    const locDev = Math.atan2(-crossTrack, Math.max(dist, 1000)) * R2D;
    const desiredAlt = desiredAltAt(E, dist);
    const altError = alt - desiredAlt;
    const gsDev = Math.atan2(altError, Math.max(dist, 300)) * R2D;
    const bearing = G.dirToHeading(thr.x - pos.x, thr.z - pos.z);
    const headingDiff = G.wrap180((s.heading || 0) - E.heading);
    const len = E.length || 3000;
    const locLimit = wasOnFinal ? 15 : 12, hdgLimit = wasOnFinal ? 50 : 45;
    const onFinal = dist < 14000 && dist > -len && Math.abs(locDev) < locLimit && Math.abs(headingDiff) < hdgLimit;
    const established = onFinal && Math.abs(locDev) < 1.5 && Math.abs(gsDev) < 0.7;
    const c = centerOf(E);
    return {
      E, alt, along, dist, crossTrack, locDev, gsDev, desiredAlt, altError, bearing, headingDiff, onFinal, established,
      distCenter: G.dist(pos.x, pos.z, c.x, c.z), distThr: G.dist(pos.x, pos.z, thr.x, thr.z),
    };
  }
  function capturable(g) { return g.dist > 800 && g.dist < 15000 && Math.abs(g.locDev) < 25 && Math.abs(g.headingDiff) < 60; }

  function papiString(E, s, g) {
    if (typeof E.papiState === 'string' && /^[RW]{4}$/.test(E.papiState)) return E.papiState;
    const p = E.papi || tdzOf(E);
    const d = Math.max(G.dist(s.pos.x, s.pos.z, p.x, p.z), 50);
    const ang = Math.atan2(g.alt - elevOf(E), d) * R2D;
    const whites = ang > 3.5 ? 4 : ang > 3.17 ? 3 : ang > 2.83 ? 2 : ang > 2.5 ? 1 : 0;
    return 'R'.repeat(4 - whites) + 'W'.repeat(whites);
  }

  // Flight plan -----------------------------------------------------
  function planApproach(E, g, s) {
    const dir = E.dir, thr = E.threshold, tdz = tdzOf(E), p = perpRight(dir);
    const pt = (d, off) => ({ x: thr.x - dir.x * d + p.x * (off || 0), z: thr.z - dir.z * d + p.z * (off || 0) });
    const iaf = Object.assign(pt(IAF_DIST), { y: desiredAltAt(E, IAF_DIST), name: 'IAF' });
    const thrWp = { x: thr.x, y: elevOf(E) + TCH, z: thr.z, name: 'THR' };
    const tdzWp = { x: tdz.x, y: elevOf(E), z: tdz.z, name: 'TDZ' };
    let wp, legs, mode;
    if (g.onFinal) {
      wp = g.dist > 1000 ? thrWp : tdzWp; legs = [wp]; mode = 'final';
    } else if (g.dist >= IAF_DIST) {
      wp = iaf; legs = [iaf, thrWp]; mode = 'iaf';
    } else {
      // Inside 10 km: intercept the centerline ahead if we are in the approach cone (with hysteresis), else downwind.
      const ui = g.dist - Math.max(1.5 * Math.abs(g.crossTrack), 1500);
      const wasIntercept = lastMode === 'intercept';
      const cone = wasIntercept ? 35 : 25, minUi = wasIntercept ? 900 : 1500;
      if (g.dist > 2500 && Math.abs(g.locDev) < cone && Math.abs(g.headingDiff) < 100 && ui >= minUi) {
        wp = Object.assign(pt(ui), { y: desiredAltAt(E, ui), name: 'FINAL' }); legs = [wp, thrWp]; mode = 'intercept';
      } else {
        const side = g.crossTrack >= 0 ? 1 : -1;
        const dw = Object.assign(pt(DW_DIST, side * DW_OFFSET), { y: desiredAltAt(E, DW_DIST), name: 'DW' });
        if (!dwReached && G.dist(s.pos.x, s.pos.z, dw.x, dw.z) < DW_CAPTURE) dwReached = true;
        if (dwReached) { wp = iaf; legs = [iaf, thrWp]; mode = 'iaf'; }
        else { wp = dw; legs = [dw, iaf, thrWp]; mode = 'downwind'; }
      }
    }
    lastMode = mode;
    // Centerline capture on final: the contract's 0.05 deg/m law far out, tightening to 0.15 deg/m inside
    // ~1.5 km (intercept angle proportional to the angular deviation) so a late intercept still converges.
    const gain = clamp(4 * R2D / Math.max(g.dist, 1000), 0.05, 0.15);
    const desiredHeading = g.onFinal
      ? G.wrap360(E.heading + clamp(-g.crossTrack * gain, -30, 30))
      : G.dirToHeading(wp.x - s.pos.x, wp.z - s.pos.z);
    const vs = vSpeeds();
    const speedCue = g.onFinal ? vs.approach : (mode === 'iaf' && g.dist > 12000 ? vs.cruise : 40);
    return { wp, legs, mode, desiredHeading, wpDist: G.dist(s.pos.x, s.pos.z, wp.x, wp.z), speedCue, iaf, thr: thrWp };
  }

  function planDeparture(E, g, s, set) {
    const c = centerOf(E), vs = vSpeeds();
    const next = set && set.nextIndex >= 0 ? set.rings[set.nextIndex] : null;
    const wp = next
      ? { x: next.x, y: next.y, z: next.z, name: 'GATE ' + (set.nextIndex + 1) }
      : { x: c.x + E.dir.x * 7000, y: climbTargetAlt(E), z: c.z + E.dir.z * 7000, name: 'DEP' };
    const legs = [];
    if (set) for (let i = Math.max(set.nextIndex, 0); i < set.rings.length; i++) { const r = set.rings[i]; if (r.state === 'pending') legs.push({ x: r.x, z: r.z }); }
    if (!legs.length) legs.push({ x: wp.x, z: wp.z });
    const desiredHeading = G.wrap360(E.heading + clamp(-g.crossTrack * 0.05, -30, 30));
    return {
      wp, legs, mode: s.onGround ? 'takeoff-roll' : 'departure', desiredHeading,
      wpDist: G.dist(s.pos.x, s.pos.z, wp.x, wp.z), speedCue: s.onGround ? vs.rotate : 40, iaf: null, thr: null,
    };
  }

  // Gate rings ------------------------------------------------------
  function approachDefs(E) {
    const defs = [];
    for (let d = GATE_FAR; d >= GATE_NEAR - 1; d -= GATE_STEP) {
      const t = (d - GATE_NEAR) / (GATE_FAR - GATE_NEAR);
      defs.push({ x: E.threshold.x - E.dir.x * d, y: desiredAltAt(E, d), z: E.threshold.z - E.dir.z * d, a: -d, radius: GATE_R_NEAR + (GATE_R_FAR - GATE_R_NEAR) * t });
    }
    return defs; // far -> near, plane coordinate `a` ascending
  }
  function departureDefs(E) {
    const defs = [], c = centerOf(E), half = (E.length || 2000) / 2;
    for (let i = 0; i < DEP_COUNT; i++) {
      const sd = DEP_FROM + (DEP_TO - DEP_FROM) * i / (DEP_COUNT - 1);
      const x = c.x + E.dir.x * sd, z = c.z + E.dir.z * sd;
      let y = Math.max(elevOf(E) + DEP_BASE + DEP_GRADIENT * (sd - DEP_FROM), groundHeight(x, z) + 60);
      try { const top = FS.city && FS.city.getObstacleTop ? FS.city.getObstacleTop(x, z) : -Infinity; if (isFinite(top)) y = Math.max(y, top + 40); } catch (e) { /* ignore */ }
      defs.push({ x, y, z, a: half + sd, radius: DEP_RADIUS });
    }
    return defs;
  }
  function makeGateSet(kind, E, defs) {
    const c = colors();
    const group = new THREE.Group();
    group.name = 'nav-' + kind + '-gates';
    const yaw = Math.atan2(E.dir.x, E.dir.z); // local +Z of the torus -> E.dir
    const rings = defs.map((d) => {
      const mat = new THREE.MeshBasicMaterial({ color: c.cyan.clone(), transparent: true, opacity: 0.75, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(d.radius, 1.6, 8, 40), mat);
      mesh.position.set(d.x, d.y, d.z);
      mesh.rotation.y = yaw;
      mesh.renderOrder = 5;
      group.add(mesh);
      return { mesh, mat, x: d.x, y: d.y, z: d.z, a: d.a, radius: d.radius, state: 'pending', t: 0 };
    });
    return { kind, E, group, rings, prevA: null, prevCt: 0, prevY: 0, passed: 0, missed: 0, nextIndex: -1, done: false };
  }
  function disposeSet(set) {
    if (!set) return;
    try {
      if (scene && set.group.parent) scene.remove(set.group);
      set.group.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    } catch (e) { warnOnce('dispose', e); }
  }
  function resetGateStates(set) {
    if (!set) return;
    for (const r of set.rings) { r.state = 'pending'; r.t = 0; }
    set.passed = 0; set.missed = 0; set.nextIndex = -1; set.done = false; set.prevA = null;
  }

  function updateGateSet(set, s, dt) {
    const E = set.E, pos = s.pos, alt = altOf(s), rings = set.rings;
    const a = G.alongTrack(pos.x, pos.z, E.threshold.x, E.threshold.z, E.dir.x, E.dir.z);
    const ct = G.crossTrack(pos.x, pos.z, E.threshold.x, E.threshold.z, E.dir.x, E.dir.z);
    const prevA = (set.prevA !== null && Math.abs(a - set.prevA) < 400) ? set.prevA : null; // null = first frame / teleport
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (r.state !== 'pending' && r.state !== 'skipped') continue;
      if (prevA !== null && prevA < r.a && a >= r.a) {
        const t = (r.a - prevA) / Math.max(a - prevA, 1e-6);
        const lat = set.prevCt + (ct - set.prevCt) * t;
        const vert = set.prevY + (alt - set.prevY) * t - r.y;
        const off = Math.hypot(lat, vert);
        r.t = 0;
        if (off < r.radius + 2) { r.state = 'passed'; set.passed++; emit('gatePassed', { index: i, total: rings.length, set: set.kind }); }
        else if (off < Math.max(300, r.radius * 6)) { r.state = 'missed'; set.missed++; emit('gateMissed', { index: i, total: rings.length, set: set.kind }); }
        else r.state = 'skipped'; // crossed the plane far away (e.g. intercepting from the side): not an attempt
      } else if (r.a < a - 30) r.state = 'skipped';
      else if (r.state === 'skipped' && r.a > a + 200) r.state = 'pending';
    }
    set.prevA = a; set.prevCt = ct; set.prevY = alt;
    set.nextIndex = -1;
    for (let i = 0; i < rings.length; i++) { if (rings[i].state === 'pending' && rings[i].a > a) { set.nextIndex = i; break; } }
    if (set.kind === 'departure') {
      const first = rings[0], last = rings[rings.length - 1];
      set.done = set.nextIndex < 0 || a > last.a + 500 || (Math.abs(ct) > 1500 && a > first.a - 1000);
    }
    // visuals
    const c = colors();
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i], m = r.mat;
      r.t += dt;
      let sc = 1;
      if (i === set.nextIndex) { sc = 1 + 0.05 * (pulse * 2 - 1); m.color.copy(c.cyan).lerp(c.white, 0.25 + 0.3 * pulse); m.opacity = 0.95; }
      else if (r.state === 'passed') { m.color.copy(c.green); m.opacity = Math.max(0.15, 0.9 - r.t * 0.25); }
      else if (r.state === 'missed') { m.color.copy(c.amber); m.opacity = Math.max(0.3, 0.85 - r.t * 0.2); }
      else if (r.state === 'skipped') { m.color.copy(c.cyan); m.opacity = 0.25; }
      else { m.color.copy(c.cyan); m.opacity = 0.75; }
      if (r.mesh.scale.x !== sc) r.mesh.scale.setScalar(sc);
    }
  }

  // Extended centerline (flat dashes on the ground) + glide ribbon --
  function buildCenterline(E) {
    const dir = E.dir, p = perpRight(dir), thr = E.threshold;
    const verts = [], idx = [];
    const hw = 2.5, dashLen = 70, step = 120;
    for (let d = 60; d + dashLen <= 8000; d += step) {
      const base = verts.length / 3;
      const corners = [[d, -hw], [d, hw], [d + dashLen, hw], [d + dashLen, -hw]];
      for (let k = 0; k < 4; k++) {
        const x = thr.x - dir.x * corners[k][0] + p.x * corners[k][1], z = thr.z - dir.z * corners[k][0] + p.z * corners[k][1];
        verts.push(x, groundHeight(x, z) + 1.2, z);
      }
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idx);
    geom.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({ color: colors().cyan.clone(), transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 4; mesh.name = 'nav-centerline';
    return mesh;
  }
  function buildRibbon(E) {
    const dir = E.dir, thr = E.threshold;
    const yFar = desiredAltAt(E, GATE_FAR), yNear = elevOf(E) + TCH;
    const xF = thr.x - dir.x * GATE_FAR, zF = thr.z - dir.z * GATE_FAR;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([xF, yFar - 2, zF, xF, yFar + 2, zF, thr.x, yNear + 2, thr.z, thr.x, yNear - 2, thr.z], 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    geom.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({ color: colors().cyan.clone(), transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 3; mesh.name = 'nav-glide-ribbon';
    return mesh;
  }

  function rebuildApproach() {
    disposeSet(approachSet); approachSet = null;
    const E = nav.target;
    if (!validEnd(E) || !scene || typeof THREE === 'undefined') return;
    try {
      approachSet = makeGateSet('approach', E, approachDefs(E));
      approachSet.group.add(buildCenterline(E));
      approachSet.group.add(buildRibbon(E));
      scene.add(approachSet.group);
    } catch (e) { approachSet = null; warnOnce('rebuildApproach', e); }
  }
  function rebuildDeparture() {
    disposeSet(departureSet); departureSet = null;
    const E = nav.target;
    if (!validEnd(E) || !scene || typeof THREE === 'undefined') return;
    try {
      departureSet = makeGateSet('departure', E, departureDefs(E));
      scene.add(departureSet.group);
    } catch (e) { departureSet = null; warnOnce('rebuildDeparture', e); }
  }
  function departureActive() { return !!(departureSet && !departureSet.done && nav.phase !== 'landing'); }
  function guidanceVisible() { return !!nav.gatesEnabled && !(FS.settings && FS.settings.guidance === false); }
  function updateVisibility() {
    const vis = guidanceVisible();
    if (approachSet) approachSet.group.visible = vis && nav.phase !== 'takeoff';
    if (departureSet) departureSet.group.visible = vis && !departureSet.done;
  }

  // Target / phase --------------------------------------------------
  function setTargetInternal(end) {
    nav.target = validEnd(end) ? end : null;
    dwReached = false; landed = false; rolledOut = false; lastMode = null; wasOnFinal = false; retargetTime = 0;
    rebuildApproach();
    if (nav.phase === 'takeoff') rebuildDeparture();
    updateVisibility();
    emit('targetChanged', { end: nav.target });
  }
  function setTarget(end) { userPinned = false; setTargetInternal(end); }

  function applyPhase(p, external) {
    if (PHASES.indexOf(p) < 0) return;
    const prev = nav.phase;
    nav.phase = p; phaseTime = 0; landed = false; rolledOut = false; dwReached = false; lastMode = null; wasOnFinal = false;
    if (p === 'takeoff') rebuildDeparture();
    else if (external) { disposeSet(departureSet); departureSet = null; }
    if (p === 'landing') resetGateStates(approachSet);
    updateVisibility();
    emit('phaseChanged', { phase: p, prev });
  }
  function setPhase(p) { applyPhase(p, true); }

  function autoTarget() {
    const list = ends().filter(validEnd);
    if (!list.length) return null;
    const s = state();
    if (!s) return list[0];
    let best = null, bestScore = Infinity;
    for (const e of list) {
      const d = G.dist(s.pos.x, s.pos.z, e.threshold.x, e.threshold.z);
      const score = d + 3000 * (1 - Math.cos(G.wrap180((s.heading || 0) - e.heading) * D2R));
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }
  function cycleTarget() {
    const list = ends().filter(validEnd);
    if (!list.length) { showMessage('No runways available', 1200); return null; }
    const s = state();
    const px = s ? s.pos.x : 0, pz = s ? s.pos.z : 0;
    const sorted = list.slice().sort((a, b) => G.dist(px, pz, a.threshold.x, a.threshold.z) - G.dist(px, pz, b.threshold.x, b.threshold.z));
    const idx = sorted.indexOf(nav.target);
    const next = sorted[idx < 0 ? 0 : (idx + 1) % sorted.length];
    setTargetInternal(next);
    userPinned = true;
    const d = G.dist(px, pz, next.threshold.x, next.threshold.z);
    showMessage('Target ' + (next.icao || '') + ' ' + (next.id || '') + ' · ' + fmtNm(d) + ' · ' + fmtHdg(next.heading), 1800);
    return next;
  }

  function updatePhase(s, g) {
    const E = nav.target;
    if (s.crashed) return;
    const canSwitch = phaseTime >= MIN_DWELL;
    if (nav.phase === 'takeoff') {
      if (E && g && canSwitch && !s.onGround && g.distCenter > 2000 && (s.agl || 0) > 150) applyPhase('free', false);
    } else if (nav.phase === 'free') {
      if (!E) { if (ends().length) setTargetInternal(autoTarget()); return; }
      if (!canSwitch || !g) return;
      if (capturable(g) || (g.onFinal && g.dist > 800)) { applyPhase('landing', false); return; }
      if (!userPinned && retargetTime >= MIN_DWELL && !departureActive()) {
        // Lined up with some other runway end? Then that is the one the pilot wants.
        let best = null, bestScore = Infinity;
        for (const e of ends()) {
          if (e === E || !validEnd(e)) continue;
          const ge = computeGeometry(e, s);
          if (!capturable(ge) || Math.abs(ge.headingDiff) > 45) continue;
          const score = Math.abs(ge.crossTrack) + ge.dist * 0.2;
          if (score < bestScore) { bestScore = score; best = e; }
        }
        if (best) { setTargetInternal(best); showMessage('Runway ' + best.id + ' ahead · target ' + best.icao + ' ' + best.id, 2000); }
      }
    } else if (E && g) { // landing
      if (s.onGround && g.dist < 150) {
        landed = true;
        const gs = typeof s.groundSpeed === 'number' ? s.groundSpeed : (s.airspeed || 0);
        if (gs < 3) rolledOut = true;
      }
      if (!canSwitch || s.onGround) return;
      if (landed) { if ((s.agl || 0) > 60) applyPhase('takeoff', false); return; } // touch-and-go
      const goAround = (s.vs || 0) > 1.5 && g.gsDev > 4 && (s.agl || 0) > 120;
      const left = g.dist < -(E.length || 3000) - 300 || g.dist > 16000 || Math.abs(g.locDev) > 45 || Math.abs(g.headingDiff) > 100;
      if (goAround || left) applyPhase('free', false);
    }
  }

  // Instruction text ------------------------------------------------
  function buildInstruction(s, E, g, plan, dep) {
    if (s.crashed) return 'Crashed · press R to restart';
    const vs = vSpeeds(), he = G.wrap180(plan.desiredHeading - (s.heading || 0));
    if (dep) {
      if (s.onGround) {
        const rot = fmtKt(vs.rotate, 5);
        if ((s.airspeed || 0) < 3) return 'Line up · full throttle · rotate at ' + rot;
        if ((s.airspeed || 0) < vs.rotate) return 'Full throttle · hold centerline · rotate at ' + rot;
        return 'Rotate · pitch up 8°';
      }
      const set = departureSet, total = set ? set.rings.length : 0;
      const gate = set && set.nextIndex >= 0 ? ' · gate ' + (set.nextIndex + 1) + ' of ' + total : '';
      const steer = Math.abs(he) > 8 ? (he > 0 ? 'Turn right to ' : 'Turn left to ') + fmtHdg(plan.desiredHeading) + ' · ' : '';
      return steer + 'Climb straight ahead to ' + fmtFt(climbTargetAlt(E)) + gate;
    }
    if (landed) return rolledOut ? 'Rolled out · welcome to ' + (E.airportName || E.icao || 'the airport') : 'Brakes · hold centerline';
    if (g.onFinal) {
      if ((s.agl || 0) < 30 && g.dist < 900) return 'Flare · idle · hold centerline';
      const loc = Math.abs(g.locDev) < 1.5 ? 'On localizer' : (he > 0 ? 'Turn right to ' : 'Turn left to ') + fmtHdg(plan.desiredHeading);
      const gs = Math.abs(g.gsDev) < 0.7 ? 'on glideslope' : g.gsDev > 0 ? 'above glideslope · reduce power' : 'below glideslope · add power';
      const parts = [loc, gs];
      if (g.dist > 900) parts.push(fmtNm(g.dist));
      else if ((s.airspeed || 0) > vs.approach + 5) parts.push('slow to ' + fmtKt(vs.approach));
      return parts.join(' · ');
    }
    const turn = Math.abs(he) < 5 ? 'Fly heading ' + fmtHdg(plan.desiredHeading) : (he > 0 ? 'Turn right to ' : 'Turn left to ') + fmtHdg(plan.desiredHeading);
    const dAlt = plan.wp.y - g.alt;
    const alt = dAlt > 30 ? 'climb to ' + fmtFt(plan.wp.y) : dAlt < -30 ? 'descend to ' + fmtFt(plan.wp.y) : 'hold ' + fmtFt(plan.wp.y);
    return turn + ' · ' + alt + ' · ' + plan.wp.name + ' ' + fmtNm(plan.wpDist);
  }

  // Guidance assembly -----------------------------------------------
  function fillEmpty(s) {
    const gd = guidance, vs = vSpeeds();
    gd.target = null; gd.phase = nav.phase; gd.phaseTime = phaseTime;
    gd.dist = 0; gd.bearing = 0; gd.alongTrack = 0; gd.crossTrack = 0; gd.locDev = 0; gd.gsDev = 0;
    gd.desiredAlt = s ? altOf(s) : 0; gd.altError = 0; gd.desiredHeading = s ? (s.heading || 0) : 0; gd.headingError = 0;
    gd.onFinal = false; gd.established = false; gd.wp = null; gd.wpDist = 0; gd.mode = 'none';
    gd.gates.total = 0; gd.gates.passed = 0; gd.gates.missed = 0; gd.gates.next = null; gd.gates.index = -1; gd.gates.set = null;
    gd.speedCue = vs.cruise; gd.papi = 'RRRR'; gd.landed = false; gd.rolledOut = false; gd.agl = s ? (s.agl || 0) : 0;
    gd.instruction = !s ? 'No aircraft' : s.crashed ? 'Crashed · press R to restart'
      : s.onGround ? 'Free flight · full throttle to take off · L picks a runway' : 'Free flight · press L to pick a runway';
    lastPlan = null;
  }

  function fillGuidance(s, E, g, plan) {
    const gd = guidance;
    const dep = plan.mode === 'takeoff-roll' || plan.mode === 'departure';
    gd.target = E; gd.phase = nav.phase; gd.phaseTime = phaseTime; gd.agl = s.agl || 0;
    gd.dist = g.dist; gd.bearing = g.bearing; gd.alongTrack = g.along; gd.crossTrack = g.crossTrack;
    gd.locDev = dep ? Math.atan2(-g.crossTrack, 3000) * R2D : g.locDev;
    gd.desiredAlt = dep ? plan.wp.y : landed ? g.alt : g.desiredAlt;
    gd.altError = g.alt - gd.desiredAlt;
    gd.gsDev = dep ? Math.atan2(gd.altError, Math.max(plan.wpDist, 300)) * R2D : landed ? 0 : g.gsDev;
    gd.desiredHeading = plan.desiredHeading;
    gd.headingError = G.wrap180(plan.desiredHeading - (s.heading || 0));
    gd.onFinal = !dep && g.onFinal; gd.established = !dep && g.established;
    gd.wp = plan.wp; gd.wpDist = plan.wpDist; gd.mode = plan.mode;
    gd.speedCue = landed ? 0 : plan.speedCue;
    gd.papi = papiString(E, s, g);
    gd.landed = landed; gd.rolledOut = rolledOut;
    const set = dep ? departureSet : approachSet;
    const gates = gd.gates;
    if (set) {
      gates.total = set.rings.length; gates.passed = set.passed; gates.missed = set.missed; gates.index = set.nextIndex; gates.set = set.kind;
      const n = set.nextIndex >= 0 ? set.rings[set.nextIndex] : null;
      gates.next = n ? { x: n.x, y: n.y, z: n.z } : null;
    } else { gates.total = 0; gates.passed = 0; gates.missed = 0; gates.index = -1; gates.set = null; gates.next = null; }
    gd.instruction = buildInstruction(s, E, g, plan, dep);
    // Data for the minimap (built here so drawMinimap stays cheap)
    const dots = set ? set.rings.map((r, i) => ({ x: r.x, z: r.z, state: i === set.nextIndex ? 'next' : r.state })) : [];
    const c = centerOf(E);
    lastPlan = {
      approach: { iaf: { x: E.threshold.x - E.dir.x * IAF_DIST, z: E.threshold.z - E.dir.z * IAF_DIST }, thr: { x: E.threshold.x, z: E.threshold.z } },
      legs: plan.legs, wp: plan.wp, gates: dots,
      departure: dep ? [{ x: c.x, z: c.z }, { x: c.x + E.dir.x * DEP_TO, z: c.z + E.dir.z * DEP_TO }] : null,
    };
  }

  // Hotkeys ---------------------------------------------------------
  function handleHotkeys() {
    const inp = FS.input;
    if (!inp || !inp.enabled || !inp.wasPressed) return;
    if (inp.wasPressed('KeyL')) cycleTarget();
    if (inp.wasPressed('KeyN')) {
      nav.gatesEnabled = !nav.gatesEnabled;
      updateVisibility();
      showMessage('Guidance gates ' + (nav.gatesEnabled ? 'on' : 'off'), 1200);
    }
  }

  // Public: update --------------------------------------------------
  function update(dt) {
    try { updateImpl(typeof dt === 'number' && isFinite(dt) ? dt : 0); }
    catch (e) { warnOnce('update', e); }
  }
  function updateImpl(dt) {
    handleHotkeys();
    const s = state();
    if (!s) { fillEmpty(null); return; }
    time += dt; phaseTime += dt; retargetTime += dt;
    let E = nav.target, g = E ? computeGeometry(E, s) : null;
    updatePhase(s, g);
    if (nav.target !== E) { E = nav.target; g = E ? computeGeometry(E, s) : null; }
    wasOnFinal = !!(g && g.onFinal);
    if (approachSet) updateGateSet(approachSet, s, dt);
    if (departureSet) updateGateSet(departureSet, s, dt);
    updateVisibility();
    if (!E || !g) { fillEmpty(s); return; }
    const plan = (nav.phase === 'takeoff' || departureActive()) ? planDeparture(E, g, s, departureSet) : planApproach(E, g, s);
    fillGuidance(s, E, g, plan);
  }

  // Public: init ----------------------------------------------------
  function init(sceneRef) {
    scene = sceneRef || null;
    try {
      if (FS.events && FS.events.on) {
        FS.events.on('reset', () => {
          if (approachSet) approachSet.prevA = null;
          if (departureSet) departureSet.prevA = null;
          landed = false; rolledOut = false; dwReached = false; lastMode = null;
        });
        FS.events.on('takeoff', (d) => {
          if (nav.phase === 'takeoff') return;
          const s = state(); if (!s) return;
          // Lifted off a runway while not in the takeoff phase (touch-and-go, or a landing made in free flight):
          // guide the departure from the end that matches the aircraft's heading.
          let best = null, bestDiff = 30;
          for (const e of ends()) {
            if (!validEnd(e)) continue;
            const c = centerOf(e);
            if (G.dist(s.pos.x, s.pos.z, c.x, c.z) > 3500) continue;
            const diff = Math.abs(G.wrap180((s.heading || 0) - e.heading));
            if (diff < bestDiff) { bestDiff = diff; best = e; }
          }
          if (!best && d && validEnd(d.runwayEnd)) best = d.runwayEnd;
          if (best) { setTargetInternal(best); applyPhase('takeoff', false); }
        });
        FS.events.on('settingsChanged', updateVisibility);
      }
    } catch (e) { warnOnce('init-events', e); }
    if (nav.target) { rebuildApproach(); if (nav.phase === 'takeoff') rebuildDeparture(); }
    updateVisibility();
    fillEmpty(state());
  }

  // Public: minimap -------------------------------------------------
  function getMinimap() {
    if (minimap) return minimap;
    const factory = typeof createMinimap === 'function' ? createMinimap : null;
    if (!factory) return null;
    try { minimap = factory(FS); } catch (e) { warnOnce('minimap-create', e); }
    return minimap;
  }
  function drawMinimap(canvas, rangeMeters) {
    try {
      const mm = getMinimap();
      if (!mm || !canvas) return;
      const s = state();
      let lm = FS.city && Array.isArray(FS.city.landmarks) && FS.city.landmarks.length ? FS.city.landmarks : null;
      if (!lm) lm = (FS.CONFIG && FS.CONFIG.landmarks) || [];
      let gc = [];
      try { gc = (FS.world && FS.world.getGroundCanvases && FS.world.getGroundCanvases()) || []; } catch (e) { gc = []; }
      mm.draw(canvas, rangeMeters, {
        pos: s ? { x: s.pos.x, z: s.pos.z } : { x: 0, z: 0 },
        heading: s ? (s.heading || 0) : 0,
        ends: ends(), target: nav.target, phase: nav.phase,
        plan: lastPlan || { approach: null, legs: [], wp: null, gates: [], departure: null },
        landmarks: lm, groundCanvases: gc,
      });
    } catch (e) { warnOnce('drawMinimap', e); }
  }

  // ---------------------------------------------------------------
  // Minimap renderer (north-up, aircraft-centred; base map cached from the world ground canvases)
  // ---------------------------------------------------------------
  function createMinimap(FS) {
    'use strict';
    const cfg = (FS && FS.CONFIG) || {};
    const M_TO_NM = (FS && FS.units && FS.units.M_TO_NM) || 1 / 1852;
    const D2R = Math.PI / 180, TAU = Math.PI * 2;
    const FONT = `'IBM Plex Mono', ui-monospace, Menlo, monospace`;
    const SEA = '#0b1a26', FLAT = '#10202c', DARKEN = 'rgba(5,12,20,0.25)';
    const WHITE = '#ffffff', CYAN = '#35d6ff', MAGENTA = '#ff5ce6', GREEN = '#5bff8a', AMBER = '#ffb347';
    const GREY = 'rgba(255,255,255,0.35)', OUTLINE = 'rgba(0,0,0,0.85)', DIM = 'rgba(255,255,255,0.8)';
    const RING = 'rgba(255,255,255,0.18)', RING_TXT = 'rgba(255,255,255,0.55)', WARM = 'rgba(255,236,200,0.95)';
    const TOP_NAMES = ['Taipei 101', 'Grand Hotel', 'Yangmingshan', 'Tamsui', 'Guanyin'];
    const SCALE_STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const WORLD_PX = 1024, INNER_PX = 2048, MAX_LANDMARK_LABELS = 8;
    const ORIGIN = { x: 0, z: 0 }, NO_DASH = [];

    // Offscreen base maps, built lazily from the world's ground canvases (see ensureCaches).
    let baseWorld = null, baseInner = null, worldRect = null, innerRect = null;
    let warned = false;
    let fallbackLandmarks = null;
    const runways = new Map();   // runway key -> per-frame record (reused, cleared each draw)
    const airports = new Map();  // icao -> per-frame record
    const labelBoxes = [];       // flat [x, y, w, ...] of landmark labels placed this frame
    const dash = [4, 4];

    // Per-draw view state: canvas size, px per meter, aircraft position, visible world rect, cull margin (m).
    const V = { W: 0, H: 0, s: 1, cx: 0, cz: 0, x0: 0, x1: 0, z0: 0, z1: 0, margin: 0 };
    let k = 1, curFont = '';

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const fin = (v) => typeof v === 'number' && isFinite(v);
    const num = (v, d) => (fin(v) ? v : d);
    const pt = (p) => (p && fin(p.x) && fin(p.z) ? p : null);
    const px = (x) => (x - V.cx) * V.s + V.W / 2;
    const py = (z) => (z - V.cz) * V.s + V.H / 2;
    const inView = (x, z, m) => x >= V.x0 - m && x <= V.x1 + m && z >= V.z0 - m && z <= V.z1 + m;
    const validRect = (r) => !!r && fin(r.x0) && fin(r.x1) && fin(r.z0) && fin(r.z1) && r.x1 > r.x0 && r.z1 > r.z0;

    function warnOnce(e) {
      if (warned) return;
      warned = true;
      if (typeof console !== 'undefined' && console.warn) console.warn('[nav-minimap] draw failed:', e);
    }

    function text(ctx, str, x, y, color, align, baseline, size) {
      const f = (size || 11 * k) + 'px ' + FONT;
      if (f !== curFont) { ctx.font = f; curFont = f; }
      ctx.textAlign = align || 'left';
      ctx.textBaseline = baseline || 'alphabetic';
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = OUTLINE;
      ctx.lineJoin = 'round';
      ctx.strokeText(str, x, y);
      ctx.fillStyle = color || WHITE;
      ctx.fillText(str, x, y);
    }

    function dot(ctx, x, y, r, color) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
    }

    function fmtDist(m) {
      if (m >= 1000) return (Math.round(m / 100) / 10) + ' km';
      return Math.round(m) + ' m';
    }

    // Bounding-box test of a point list against the view (cheap cull for polylines).
    function ptsInView(pts) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, n = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pt(pts[i]);
        if (!p) continue;
        n++;
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
        if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
      }
      const m = V.margin;
      return n > 0 && x1 >= V.x0 - m && x0 <= V.x1 + m && z1 >= V.z0 - m && z0 <= V.z1 + m;
    }
    function segInView(a, b) {
      const m = V.margin;
      return Math.max(a.x, b.x) >= V.x0 - m && Math.min(a.x, b.x) <= V.x1 + m &&
        Math.max(a.z, b.z) >= V.z0 - m && Math.min(a.z, b.z) <= V.z1 + m;
    }

    // Draw the part of `src` (a canvas covering world rect `sr`) that overlaps `dr`, the world rect covered by a
    // dw x dh pixel destination. Source and destination rects are clipped together, so nothing is ever stretched.
    function blit(ctx, dw, dh, dr, src, sr) {
      const ix0 = Math.max(dr.x0, sr.x0), ix1 = Math.min(dr.x1, sr.x1);
      const iz0 = Math.max(dr.z0, sr.z0), iz1 = Math.min(dr.z1, sr.z1);
      if (!(ix1 > ix0 && iz1 > iz0)) return;
      const skx = src.width / (sr.x1 - sr.x0), skz = src.height / (sr.z1 - sr.z0);
      const dkx = dw / (dr.x1 - dr.x0), dkz = dh / (dr.z1 - dr.z0);
      ctx.drawImage(src, (ix0 - sr.x0) * skx, (iz0 - sr.z0) * skz, (ix1 - ix0) * skx, (iz1 - iz0) * skz,
        (ix0 - dr.x0) * dkx, (iz0 - dr.z0) * dkz, (ix1 - ix0) * dkx, (iz1 - iz0) * dkz);
    }

    function makeCanvas(w, h) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      ctx.imageSmoothingEnabled = true;
      try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* optional */ }
      return c;
    }

    // Pre-render baseWorld (1024², whole world) and baseInner (2048², the inner rect) from the ground canvases.
    // Returns false (and caches nothing) when there is nothing usable yet; draw() retries on later calls.
    function ensureCaches(list) {
      if (baseWorld && baseInner) return true;
      if (typeof document === 'undefined' || !Array.isArray(list) || !list.length) return false;
      const valid = [];
      for (let i = 0; i < list.length; i++) {
        const g = list[i];
        if (!g || !g.canvas || !(g.canvas.width > 0) || !(g.canvas.height > 0)) continue;
        const r = validRect(g.rect) ? g.rect : (g.isInner && validRect(cfg.innerRect) ? cfg.innerRect : null);
        if (!r) continue;
        valid.push({ canvas: g.canvas, rect: r, inner: !!g.isInner, area: (r.x1 - r.x0) * (r.z1 - r.z0) });
      }
      if (!valid.length) return false;
      valid.sort((a, b) => a.area - b.area);
      const inner = valid.find((v) => v.inner) || valid[0];
      const outer = valid[valid.length - 1];
      try {
        const half = num(cfg.worldHalfSize, 36000);
        const wr = { x0: -half, z0: -half, x1: half, z1: half };
        const ir = { x0: inner.rect.x0, z0: inner.rect.z0, x1: inner.rect.x1, z1: inner.rect.z1 };
        const bi = makeCanvas(INNER_PX, INNER_PX), bw = makeCanvas(WORLD_PX, WORLD_PX);
        const ci = bi.getContext('2d'), cw = bw.getContext('2d');
        ci.drawImage(inner.canvas, 0, 0, INNER_PX, INNER_PX);
        cw.fillStyle = SEA;
        cw.fillRect(0, 0, WORLD_PX, WORLD_PX);
        blit(cw, WORLD_PX, WORLD_PX, wr, outer.canvas, outer.rect);
        // composite the inner map from the already-halved cache (two-step downscale looks less aliased)
        if (inner !== outer) blit(cw, WORLD_PX, WORLD_PX, wr, bi, ir);
        baseWorld = bw; baseInner = bi; worldRect = wr; innerRect = ir;
        return true;
      } catch (e) {
        baseWorld = baseInner = worldRect = innerRect = null;
        warnOnce(e);
        return false;
      }
    }

    function drawRings(ctx, range) {
      ring(ctx, V.W * 0.25, range / 4);
      ring(ctx, V.W * 0.5, range / 2);
    }
    function ring(ctx, rPx, rM) {
      ctx.beginPath();
      ctx.arc(V.W / 2, V.H / 2, rPx, 0, TAU);
      ctx.lineWidth = 1 * k;
      ctx.strokeStyle = RING;
      ctx.stroke();
      const label = (rM * M_TO_NM).toFixed(1) + ' nm';
      const top = V.H / 2 - rPx;
      // label sits above the ring when there is room, otherwise just inside it
      if (top - 13 * k >= 0) text(ctx, label, V.W / 2, top - 2 * k, RING_TXT, 'center', 'bottom', 9 * k);
      else text(ctx, label, V.W / 2, top + 2 * k, RING_TXT, 'center', 'top', 9 * k);
    }

    function centerOf(e) {
      if (!e) return null;
      const c = pt(e.center);
      if (c) return c;
      const a = pt(e.threshold), b = pt(e.oppositeThreshold);
      return a && b ? { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 } : null;
    }
    // Two ends of the same runway share icao + center; round to 10 m so float noise can't split them.
    function runwayKeyOf(e) {
      const c = centerOf(e);
      return c ? (e.icao || '') + '|' + Math.round(c.x / 10) + '|' + Math.round(c.z / 10) : null;
    }

    function collectRunways(ends) {
      runways.clear();
      airports.clear();
      if (!Array.isArray(ends)) return;
      for (let i = 0; i < ends.length; i++) {
        const e = ends[i];
        const key = runwayKeyOf(e);
        if (!key) continue;
        let rw = runways.get(key);
        if (!rw) {
          const c = centerOf(e);
          rw = { icao: e.icao || '', name: e.airportName || e.icao || '', cx: c.x, cz: c.z, a: null, b: null,
            dx: 1, dz: 0, len: 0, width: num(e.width, 45), ends: [] };
          runways.set(key, rw);
        }
        rw.ends.push(e);
        if (!rw.a) {
          const a = pt(e.threshold), b = pt(e.oppositeThreshold);
          if (a && b) {
            const L = Math.hypot(b.x - a.x, b.z - a.z);
            rw.a = a; rw.b = b;
            rw.len = num(e.length, L) || L;
            if (L > 1e-6) { rw.dx = (b.x - a.x) / L; rw.dz = (b.z - a.z) / L; }
          }
        }
      }
    }

    function drawRunways(ctx, ends, target, range) {
      collectRunways(ends);
      if (!runways.size) return;
      const tKey = target ? runwayKeyOf(target) : null;
      const m = V.margin, wide = range >= 10000;
      ctx.lineCap = 'butt';
      for (const [key, rw] of runways) {
        const isTarget = key === tKey;
        const big = V.s * rw.len > 24 * k;
        const halfW = Math.max(3 * k, rw.width * V.s) / 2;
        let ap = airports.get(rw.icao);
        if (!ap) {
          ap = { sx: 0, sz: 0, n: 0, name: rw.name, big: false, px: 0, pz: 1, halfW: 0 };
          airports.set(rw.icao, ap);
          // perpendicular of the first runway, pointing south-ish, so the airport label sits clear of the bar
          ap.px = -rw.dz; ap.pz = rw.dx;
          if (ap.pz < 0) { ap.px = -ap.px; ap.pz = -ap.pz; }
        }
        ap.sx += rw.cx; ap.sz += rw.cz; ap.n++;
        ap.big = ap.big || big;
        if (halfW > ap.halfW) ap.halfW = halfW;

        if (rw.a && segInView(rw.a, rw.b)) {
          ctx.beginPath();
          ctx.moveTo(px(rw.a.x), py(rw.a.z));
          ctx.lineTo(px(rw.b.x), py(rw.b.z));
          ctx.lineWidth = halfW * 2;
          ctx.strokeStyle = isTarget ? CYAN : WHITE;
          ctx.stroke();
        }
        if (!inView(rw.cx, rw.cz, m)) continue;
        if (big) {
          for (let j = 0; j < rw.ends.length; j++) {
            const e = rw.ends[j], t = pt(e.threshold);
            if (!t || e.id == null || !inView(t.x, t.z, m)) continue;
            let dx, dz;
            const d = pt(e.dir);
            if (d) { dx = d.x; dz = d.z; }
            else if (fin(e.heading) && FS && FS.geo && FS.geo.headingToDir) { const hd = FS.geo.headingToDir(e.heading); dx = hd.x; dz = hd.z; }
            else {
              const nearA = !rw.a || Math.hypot(t.x - rw.a.x, t.z - rw.a.z) <= Math.hypot(t.x - rw.b.x, t.z - rw.b.z);
              dx = nearA ? rw.dx : -rw.dx; dz = nearA ? rw.dz : -rw.dz;
            }
            // number just outside its threshold, i.e. behind the landing direction
            text(ctx, String(e.id), px(t.x) - dx * 10 * k, py(t.z) - dz * 10 * k, isTarget ? CYAN : WHITE, 'center', 'middle');
          }
        } else {
          dot(ctx, px(rw.cx), py(rw.cz), 4 * k, isTarget ? CYAN : WHITE);
        }
      }
      for (const [icao, ap] of airports) {
        const cx = ap.sx / ap.n, cz = ap.sz / ap.n;
        if (!inView(cx, cz, m)) continue;
        const label = (wide || !ap.big) ? icao : ap.name;
        if (!label) continue;
        const x = px(cx), y = py(cz);
        if (ap.big) {
          const o = ap.halfW + 8 * k;
          text(ctx, label, x + ap.px * o, y + ap.pz * o, DIM, 'center', 'middle');
        } else {
          text(ctx, label, x, y + 7 * k, DIM, 'center', 'top');
        }
      }
    }

    function polyline(ctx, pts, color, width, fromCenter) {
      if (!Array.isArray(pts) || !pts.length) return;
      if (!fromCenter && !ptsInView(pts)) return;
      ctx.beginPath();
      let n = 0;
      if (fromCenter) { ctx.moveTo(V.W / 2, V.H / 2); n = 1; }
      for (let i = 0; i < pts.length; i++) {
        const p = pt(pts[i]);
        if (!p) continue;
        const x = px(p.x), y = py(p.z);
        if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        n++;
      }
      if (n < 2) return;
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    function drawRoutes(ctx, plan, phase) {
      const dep = plan.departure;
      const hasDep = Array.isArray(dep) && dep.length > 0;
      const ap = plan.approach;
      const iaf = ap ? pt(ap.iaf) : null, thr = ap ? pt(ap.thr) : null;
      if (iaf && thr && segInView(iaf, thr)) {
        // during takeoff the departure route is what matters; keep the approach line as a faint reference
        const dim = phase === 'takeoff' && hasDep;
        if (dim) ctx.globalAlpha = 0.4;
        const ix = px(iaf.x), iy = py(iaf.z);
        ctx.beginPath();
        ctx.moveTo(ix, iy);
        ctx.lineTo(px(thr.x), py(thr.z));
        ctx.lineWidth = 1.5 * k;
        ctx.strokeStyle = MAGENTA;
        ctx.stroke();
        const L = Math.hypot(thr.x - iaf.x, thr.z - iaf.z);
        if (L > 1e-6 && inView(iaf.x, iaf.z, V.margin)) {
          // unit perpendicular to the approach, flipped to point south-ish (down the map)
          let nx = -(thr.z - iaf.z) / L, nz = (thr.x - iaf.x) / L;
          if (nz < 0) { nx = -nx; nz = -nz; }
          ctx.beginPath();
          ctx.moveTo(ix - nx * 4 * k, iy - nz * 4 * k);
          ctx.lineTo(ix + nx * 4 * k, iy + nz * 4 * k);
          ctx.stroke();
          text(ctx, 'IAF', ix + nx * 10 * k, iy + nz * 10 * k, MAGENTA, 'center', 'middle');
        }
        if (dim) ctx.globalAlpha = 1;
      }
      if (hasDep) polyline(ctx, dep, MAGENTA, 1.5 * k, false);
    }

    function drawGates(ctx, gates) {
      if (!Array.isArray(gates)) return;
      const m = V.margin;
      for (let i = 0; i < gates.length; i++) {
        const g = pt(gates[i]);
        if (!g || !inView(g.x, g.z, m)) continue;
        const x = px(g.x), y = py(g.z), st = gates[i].state;
        if (st === 'next') {
          dot(ctx, x, y, 4 * k, CYAN);
          ctx.lineWidth = 1 * k;
          ctx.strokeStyle = WHITE;
          ctx.stroke();
        } else if (st === 'passed') dot(ctx, x, y, 2.5 * k, GREEN);
        else if (st === 'missed') dot(ctx, x, y, 2.5 * k, AMBER);
        else if (st === 'skipped') dot(ctx, x, y, 2.5 * k, GREY);
        else dot(ctx, x, y, 2.5 * k, MAGENTA);
      }
    }

    function drawLegs(ctx, legs) {
      if (!Array.isArray(legs) || !legs.length) return;
      dash[0] = dash[1] = 4 * k;
      ctx.setLineDash(dash);
      polyline(ctx, legs, 'rgba(53,214,255,0.8)', 1 * k, true);
      ctx.setLineDash(NO_DASH);
    }

    function drawWaypoint(ctx, wp) {
      const p = pt(wp);
      if (!p || !inView(p.x, p.z, V.margin)) return;
      const x = px(p.x), y = py(p.z), r = 6 * k;
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fillStyle = CYAN;
      ctx.fill();
      ctx.lineWidth = 1 * k;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
      if (wp.name) text(ctx, String(wp.name), x + r + 3 * k, y, CYAN, 'left', 'middle');
    }

    function fallbackLms() {
      if (!fallbackLandmarks) {
        const src = Array.isArray(cfg.landmarks) ? cfg.landmarks : [];
        fallbackLandmarks = src.filter((l) => l && fin(l.x) && fin(l.z))
          .map((l) => ({ name: l.name, x: l.x, z: l.z, top: num(l.top, num(l.height, 0)) }))
          .sort((a, b) => b.top - a.top);
      }
      return fallbackLandmarks;
    }
    function isTopName(name) {
      for (let i = 0; i < TOP_NAMES.length; i++) if (name.indexOf(TOP_NAMES[i]) >= 0) return true;
      return false;
    }
    // Rough monospace text box; refuses labels that would overlap one already placed this frame.
    function placeLabel(x, y, str) {
      const w = str.length * 6.6 * k, h = 12 * k;
      for (let i = 0; i < labelBoxes.length; i += 3) {
        const bx = labelBoxes[i], by = labelBoxes[i + 1], bw = labelBoxes[i + 2];
        if (Math.abs(y - by) < h && x < bx + bw && bx < x + w) return false;
      }
      labelBoxes.push(x, y, w);
      return true;
    }

    function drawLandmarks(ctx, list, range) {
      const lms = Array.isArray(list) && list.length ? list : fallbackLms();
      const wide = range >= 10000, m = V.margin;
      let labels = 0;
      labelBoxes.length = 0;
      for (let i = 0; i < lms.length; i++) {
        const lm = lms[i];
        if (!lm || !fin(lm.x) || !fin(lm.z) || !inView(lm.x, lm.z, m)) continue;
        const x = px(lm.x), y = py(lm.z);
        dot(ctx, x, y, 2.5 * k, WARM);
        if (labels >= MAX_LANDMARK_LABELS || !lm.name) continue;
        const full = String(lm.name);
        if (wide && !isTopName(full)) continue;
        const name = full.replace(/\s*\([^)]*\)\s*$/, '');
        if (!placeLabel(x + 5 * k, y, name)) continue;
        text(ctx, name, x + 5 * k, y, WARM, 'left', 'middle');
        labels++;
      }
    }

    // North arrow (top-left), scale bar (bottom-left), range (bottom-right).
    function drawFurniture(ctx, range) {
      const W = V.W, H = V.H;
      const nx = 14 * k, ny = 12 * k;
      ctx.beginPath();
      ctx.moveTo(nx, ny - 7 * k); ctx.lineTo(nx + 4.5 * k, ny + 5 * k); ctx.lineTo(nx, ny + 2 * k); ctx.lineTo(nx - 4.5 * k, ny + 5 * k);
      ctx.closePath();
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.lineWidth = 1 * k;
      ctx.strokeStyle = OUTLINE;
      ctx.lineJoin = 'round';
      ctx.stroke();
      text(ctx, 'N', nx, ny + 7 * k, WHITE, 'center', 'top');

      let L = SCALE_STEPS[0];
      for (let i = 0; i < SCALE_STEPS.length; i++) if (SCALE_STEPS[i] <= range / 3) L = SCALE_STEPS[i];
      const bx = 10 * k, by = H - 10 * k, bl = L * V.s;
      ctx.beginPath();
      ctx.moveTo(bx, by); ctx.lineTo(bx + bl, by);
      ctx.moveTo(bx, by - 4 * k); ctx.lineTo(bx, by + 4 * k);
      ctx.moveTo(bx + bl, by - 4 * k); ctx.lineTo(bx + bl, by + 4 * k);
      ctx.lineWidth = 3.5 * k;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = WHITE;
      ctx.stroke();
      text(ctx, fmtDist(L), bx, by - 6 * k, DIM, 'left', 'bottom');
      text(ctx, fmtDist(range), W - 6 * k, H - 6 * k, DIM, 'right', 'bottom');
    }

    function drawAircraft(ctx, heading) {
      ctx.save();
      ctx.translate(V.W / 2, V.H / 2);
      ctx.rotate(heading * D2R); // canvas rotation is clockwise, like a compass
      ctx.beginPath();
      ctx.moveTo(0, -5.5 * k); ctx.lineTo(0, -17.5 * k);
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = CYAN;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -5.5 * k); ctx.lineTo(5 * k, 3.5 * k); ctx.lineTo(0, 1.5 * k); ctx.lineTo(-5 * k, 3.5 * k);
      ctx.closePath();
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = OUTLINE;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    function drawImpl(canvas, range, view) {
      if (!canvas) return;
      const W = canvas.width | 0, H = canvas.height | 0;
      if (!(W > 0 && H > 0)) return;
      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (!ctx) return;
      view = view || {};
      if (!(fin(range) && range > 0)) range = 6000;
      const pos = pt(view.pos) || ORIGIN;
      const plan = view.plan || {};
      k = clamp(W / 240, 0.8, 3);
      curFont = '';
      V.W = W; V.H = H; V.s = W / range; V.cx = pos.x; V.cz = pos.z;
      V.x0 = pos.x - range / 2; V.x1 = pos.x + range / 2;
      const halfZ = (range * H / W) / 2;
      V.z0 = pos.z - halfZ; V.z1 = pos.z + halfZ;
      V.margin = 30 * k / V.s;

      ctx.save();
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.setLineDash(NO_DASH);
        ctx.imageSmoothingEnabled = true;
        if (ensureCaches(view.groundCanvases)) {
          ctx.fillStyle = SEA;
          ctx.fillRect(0, 0, W, H);
          blit(ctx, W, H, V, baseWorld, worldRect);
          blit(ctx, W, H, V, baseInner, innerRect);
          ctx.fillStyle = DARKEN;
          ctx.fillRect(0, 0, W, H);
        } else {
          ctx.fillStyle = FLAT;
          ctx.fillRect(0, 0, W, H);
        }
        drawRings(ctx, range);
        drawRunways(ctx, view.ends, view.target, range);
        drawRoutes(ctx, plan, view.phase);
        drawGates(ctx, plan.gates);
        drawLegs(ctx, plan.legs);
        drawWaypoint(ctx, plan.wp);
        drawLandmarks(ctx, view.landmarks, range);
        drawFurniture(ctx, range);
        drawAircraft(ctx, num(view.heading, 0));
      } finally {
        ctx.restore();
      }
    }

    return {
      draw(canvas, rangeMeters, view) {
        try { drawImpl(canvas, rangeMeters, view); } catch (e) { warnOnce(e); }
      },
      invalidate() {
        baseWorld = baseInner = worldRect = innerRect = null;
      },
    };
  }
})();
