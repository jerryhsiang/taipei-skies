/* ============================================================
   Taipei Skies — test/aircraft-physics.js
   Headless sanity test for js/aircraft.js (run: node test/aircraft-physics.js)
   Stubs window / THREE (real three r128 if it can be found, else a minimal
   Vector3/Quaternion/Euler stub), FS.world, FS.airports, FS.city, then
   simulates: (a) full-throttle takeoff, (b) level cruise, (c) idle glide,
   plus stall, landing, crash, ground steering and attitude conventions.
   Exit code 1 if any assertion fails.
   ============================================================ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------
// THREE: real build when available, otherwise a small stub
// ---------------------------------------------------------------
function loadThree() {
  const cands = [process.env.THREE_PATH, path.join(ROOT, 'node_modules', 'three'), path.join(ROOT, 'test', 'node_modules', 'three'),
    path.join(ROOT, '..', 'node_modules', 'three')];
  if (process.env.THREE_STUB) return null;
  for (const c of cands) { if (!c) continue; try { const t = require(c); if (t && t.Vector3) return t; } catch (e) { /* next */ } }
  return null;
}
function makeStub() {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
    crossVectors(a, b) { const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z; this.x = ay * bz - az * by; this.y = az * bx - ax * bz; this.z = ax * by - ay * bx; return this; }
    applyQuaternion(q) {
      const x = this.x, y = this.y, z = this.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
      this.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
      this.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
      this.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
      return this;
    }
  }
  class Quaternion {
    constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
    identity() { return this.set(0, 0, 0, 1); }
    normalize() { let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w); if (l === 0) { this.set(0, 0, 0, 1); } else { l = 1 / l; this.x *= l; this.y *= l; this.z *= l; this.w *= l; } return this; }
    conjugate() { this.x *= -1; this.y *= -1; this.z *= -1; return this; }
    invert() { return this.conjugate(); }
    multiplyQuaternions(a, b) {
      const qax = a.x, qay = a.y, qaz = a.z, qaw = a.w, qbx = b.x, qby = b.y, qbz = b.z, qbw = b.w;
      this.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
      this.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
      this.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
      this.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
      return this;
    }
    multiply(q) { return this.multiplyQuaternions(this, q); }
    premultiply(q) { return this.multiplyQuaternions(q, this); }
    setFromAxisAngle(axis, angle) { const h = angle / 2, s = Math.sin(h); this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h); return this; }
    setFromEuler(e) {
      const c1 = Math.cos(e.x / 2), c2 = Math.cos(e.y / 2), c3 = Math.cos(e.z / 2), s1 = Math.sin(e.x / 2), s2 = Math.sin(e.y / 2), s3 = Math.sin(e.z / 2);
      if (e.order !== 'YXZ') throw new Error('stub supports YXZ only');
      this.x = s1 * c2 * c3 + c1 * s2 * s3; this.y = c1 * s2 * c3 - s1 * c2 * s3; this.z = c1 * c2 * s3 - s1 * s2 * c3; this.w = c1 * c2 * c3 + s1 * s2 * s3;
      return this;
    }
  }
  class Euler {
    constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; }
    set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this; }
    setFromQuaternion(q, order) {
      const x = q.x, y = q.y, z = q.z, w = q.w, x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
      const m11 = 1 - (yy + zz), m13 = xz + wy, m21 = xy + wz, m22 = 1 - (xx + zz), m23 = yz - wx, m31 = xz - wy, m33 = 1 - (xx + yy);
      if (order !== 'YXZ') throw new Error('stub supports YXZ only');
      this.x = Math.asin(-clamp(m23, -1, 1));
      if (Math.abs(m23) < 0.9999999) { this.y = Math.atan2(m13, m33); this.z = Math.atan2(m21, m22); } else { this.y = Math.atan2(-m31, m11); this.z = 0; }
      this.order = order;
      return this;
    }
  }
  class Color { constructor() { this.r = 1; this.g = 1; this.b = 1; } convertSRGBToLinear() { return this; } }
  class Object3D {
    constructor() { this.position = new Vector3(); this.quaternion = new Quaternion(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1); this.children = []; this.visible = true; this.name = ''; }
    add() { for (const c of arguments) this.children.push(c); return this; }
  }
  class Generic { constructor() { this.position = new Vector3(); this.quaternion = new Quaternion(); this.rotation = new Euler(); this.children = []; this.opacity = 1; } add() { return this; } }
  const base = { Vector3, Quaternion, Euler, Color, Object3D, Group: class extends Object3D {}, Mesh: class extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
    DoubleSide: 2, FrontSide: 0, BackSide: 1, sRGBEncoding: 3001, LinearEncoding: 3000, RepeatWrapping: 1000, ClampToEdgeWrapping: 1001,
    LinearMipmapLinearFilter: 1008, LinearFilter: 1006 };
  return new Proxy(base, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string' && /^[A-Z]/.test(k)) return Generic; return undefined; } });
}

global.window = global; global.self = global;
global.THREE = loadThree();
const usingStub = !global.THREE;
if (usingStub) global.THREE = makeStub();
global.requestAnimationFrame = () => 0;

// ---------------------------------------------------------------
// Load config + aircraft, stub the peers
// ---------------------------------------------------------------
require(path.join(ROOT, 'js', 'config.js'));
const FS = global.FS;
const FIELD_ELEV = 5.5;
const RWY = { key: 'RCSS-10', icao: 'RCSS', id: '10', heading: 96, dir: FS.geo.headingToDir(96), elev: FIELD_ELEV, length: 2605, width: 60 };
RWY.center = { x: 3277, z: -2145 };
RWY.threshold = { x: RWY.center.x - RWY.dir.x * RWY.length / 2, z: RWY.center.z - RWY.dir.z * RWY.length / 2 };
RWY.oppositeThreshold = { x: RWY.center.x + RWY.dir.x * RWY.length / 2, z: RWY.center.z + RWY.dir.z * RWY.length / 2 };
RWY.spawn = { x: RWY.threshold.x + RWY.dir.x * 150, z: RWY.threshold.z + RWY.dir.z * 150, heading: 96 };
const RWY28 = Object.assign({}, RWY, { key: 'RCSS-28', id: '28', heading: 276, dir: FS.geo.headingToDir(276), threshold: RWY.oppositeThreshold, oppositeThreshold: RWY.threshold });
RWY28.spawn = { x: RWY28.threshold.x + RWY28.dir.x * 150, z: RWY28.threshold.z + RWY28.dir.z * 150, heading: 276 };
const world = { terrain: FIELD_ELEV, water: false, slopeX: 0 };
FS.world = {
  getHeight: (x, z) => world.terrain + world.slopeX * (x - RWY.center.x),
  isWater: () => world.water,
};
FS.city = { getObstacleTop: () => -Infinity };
function onRunwayRect(x, z) {
  const rx = x - RWY.center.x, rz = z - RWY.center.z;
  const along = rx * RWY.dir.x + rz * RWY.dir.z, cross = rx * -RWY.dir.z + rz * RWY.dir.x;
  return Math.abs(along) <= RWY.length / 2 && Math.abs(cross) <= RWY.width / 2;
}
FS.airports = {
  isOnRunway: (x, z) => (onRunwayRect(x, z) ? RWY : null),
  isOnPaved: (x, z) => onRunwayRect(x, z),
  getRunwayEnds: () => [RWY, RWY28],
  getRunwayEnd: (k) => (k === 'RCSS-10' ? RWY : k === 'RCSS-28' ? RWY28 : undefined),
};
require(path.join(ROOT, 'js', 'aircraft.js'));
const ac = FS.aircraft;
const events = [];
for (const n of ['touchdown', 'takeoff', 'crash', 'reset']) FS.events.on(n, (d) => events.push({ name: n, data: d }));
ac.init({ add() {} });

// ---------------------------------------------------------------
// helpers
// ---------------------------------------------------------------
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  — ' + detail : ''));
}
const f1 = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v));
const f2 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
const kt = (ms) => (ms * 1.943844).toFixed(0) + ' kt';
const DT = 1 / 60;
function run(seconds, pilot) {
  const s = ac.state;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (pilot) pilot(s, i * DT);
    ac.update(DT);
    if (s.crashed) return i * DT;
  }
  return seconds;
}
function runRaw(seconds, pilot) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { if (pilot) pilot(ac.state, i * DT); ac.update(DT); }
}
function stick(e, a, r) { ac.extraInput = { elevator: e || 0, aileron: a || 0, rudder: r || 0 }; }
function vsHold(targetVs, gain) {
  gain = gain || 0.2;
  return (s) => stick(Math.max(-1, Math.min(1, (targetVs - s.vs) * gain)), 0, 0);
}
function pitchHold(target, gain) {
  gain = gain || 0.08;
  return (s) => stick(Math.max(-1, Math.min(1, (target - s.pitch) * gain)), 0, 0);
}
let altI = 0;
function altHold(targetAlt) {
  altI = 0;
  return (s) => {
    const err = targetAlt - s.altitude;
    altI = Math.max(-2, Math.min(2, altI + err * 0.0005 * DT));
    const vsCmd = Math.max(-4, Math.min(4, err * 0.15));
    const e = (vsCmd - s.vs) * 0.12 + altI;
    stick(Math.max(-1, Math.min(1, e)), 0, 0);
  };
}
function speedHold(targetV) {
  return (s) => {
    // pitch for speed: too fast -> nose up
    const e = (s.airspeed - targetV) * 0.05 - s.pitch * 0.02;
    stick(Math.max(-1, Math.min(1, e)), 0, 0);
  };
}
function finite(s) {
  return [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.heading, s.pitch, s.roll, s.airspeed, s.alpha, s.gForce].every((v) => Number.isFinite(v));
}

console.log('Taipei Skies aircraft physics sanity test  (THREE: ' + (usingStub ? 'stub' : 'r' + global.THREE.REVISION) + ')');
console.log('params: mass ' + ac.params.mass + ' kg, S ' + ac.params.wingArea + ' m², maxThrust ' + ac.params.maxThrust + ' N, gearHeight ' + ac.params.gearHeight);
console.log('CLmax clean ' + f2(ac.liftCoef(17.5, 0)) + '  stall speed clean ' + f1(ac.stallSpeed(0)) + ' m/s, full flaps ' + f1(ac.stallSpeed(1)) + ' m/s');

// ---------------------------------------------------------------
// 0. attitude conventions
// ---------------------------------------------------------------
console.log('\n[0] attitude conventions');
ac.reset({ x: 0, z: 0, heading: 90, onGround: false, altitude: 500, speed: 50, throttle: 0.7 });
ac.setAttitude(90, 10, 20);
{
  const s = ac.state;
  check('heading 90 -> forward points east', Math.abs(s.forward.x - Math.cos(10 * Math.PI / 180)) < 0.01 && Math.abs(s.forward.z) < 0.01, 'fwd=(' + f2(s.forward.x) + ',' + f2(s.forward.y) + ',' + f2(s.forward.z) + ')');
  check('pitch 10 -> forward.y = sin(10°)', Math.abs(s.forward.y - Math.sin(10 * Math.PI / 180)) < 0.01, 'fwd.y=' + f2(s.forward.y));
  check('roll +20 -> right wing down (right.y < 0)', s.right.y < -0.3, 'right.y=' + f2(s.right.y));
  check('euler round trip', Math.abs(s.heading - 90) < 0.01 && Math.abs(s.pitch - 10) < 0.01 && Math.abs(s.roll - 20) < 0.01, 'h=' + f1(s.heading) + ' p=' + f1(s.pitch) + ' r=' + f1(s.roll));
}
ac.setAttitude(0, 0, 0);
// keyboard mapping: W = nose down, S = nose up; mouse below center = nose up
{
  ac.extraInput = null;
  FS.input.keys.add('KeyW'); ac.update(DT); const eW = ac.state.elevator; FS.input.keys.delete('KeyW');
  FS.input.keys.add('KeyS'); ac.update(DT); const eS = ac.state.elevator; FS.input.keys.delete('KeyS');
  FS.input.mouse.active = true; FS.input.mouse.y = 0.5; FS.input.mouse.x = 0.5; ac.update(DT);
  const eM = ac.state.elevator, aM = ac.state.aileron, mA = ac.state.mouseActive;
  FS.input.mouse.active = false; FS.input.mouse.y = 0; FS.input.mouse.x = 0; ac.update(DT);
  check('W = nose down (elevator -1), S = nose up (+1)', eW === -1 && eS === 1, 'W:' + eW + ' S:' + eS);
  check('mouse below/right of center = nose up / roll right, mouseActive', eM > 0.4 && aM > 0.4 && mA === true, 'e=' + f2(eM) + ' a=' + f2(aM));
  FS.input.keys.add('KeyD'); ac.update(DT); const aD = ac.state.aileron; FS.input.keys.delete('KeyD');
  FS.input.keys.add('KeyE'); ac.update(DT); const rE = ac.state.rudder; FS.input.keys.delete('KeyE');
  check('D = roll right, E = yaw right', aD === 1 && rE === 1, 'D:' + aD + ' E:' + rE);
  ac.update(DT);
}

// ---------------------------------------------------------------
// (a) takeoff: full throttle from rest, rotate at > 28 m/s
// ---------------------------------------------------------------
console.log('\n[a] takeoff roll, RCSS runway 10, full throttle');
events.length = 0;
ac.reset({ x: RWY.spawn.x, z: RWY.spawn.z, heading: 96, onGround: true, speed: 0, throttle: 0, flaps: 0 });
ac.setThrottle(1);
{
  const s = ac.state;
  const x0 = s.pos.x, z0 = s.pos.z;
  let distRotate = null, tRotate = null, distLiftoff = null, tLiftoff = null, vLiftoff = null, maxPitchGround = 0, maxG = 0;
  let rotating = false;
  const dist = () => Math.hypot(s.pos.x - x0, s.pos.z - z0);
  const t = run(60, (st, time) => {
    if (!rotating && st.airspeed > 28) { rotating = true; distRotate = dist(); tRotate = time; }
    if (st.onGround && st.pitch > maxPitchGround) maxPitchGround = st.pitch;
    if (st.gForce > maxG) maxG = st.gForce;
    if (!st.onGround && distLiftoff === null) { distLiftoff = dist(); tLiftoff = time; vLiftoff = st.airspeed; }
    if (!rotating) stick(0, 0, 0);
    else if (st.onGround) stick(st.pitch < 9 ? 1 : 0.3, 0, 0);          // rotate briskly to ~9 deg
    else pitchHold(8, 0.3)(st);                                          // then hold a climb attitude
  });
  const takeoffEv = events.find((e) => e.name === 'takeoff');
  console.log('  rotate speed reached after ' + f1(distRotate) + ' m / ' + f1(tRotate) + ' s;  liftoff at ' + f1(distLiftoff) + ' m / ' + f1(tLiftoff) + ' s at ' + f1(vLiftoff) + ' m/s (' + kt(vLiftoff || 0) + ')');
  console.log('  after 60 s: alt ' + f1(s.altitude) + ' m MSL, agl ' + f1(s.agl) + ' m, vs ' + f2(s.vs) + ' m/s, airspeed ' + f1(s.airspeed) + ' m/s, pitch ' + f1(s.pitch) + '°, max ground pitch ' + f1(maxPitchGround) + '°, max g ' + f2(maxG));
  check('reaches rotate speed (28 m/s) within 350 m', distRotate !== null && distRotate < 350, f1(distRotate) + ' m');
  check('lifts off', distLiftoff !== null && !s.onGround && !s.crashed, distLiftoff === null ? 'never left the ground' : f1(distLiftoff) + ' m, ' + f1(vLiftoff) + ' m/s');
  check('liftoff speed between 28 and 40 m/s', vLiftoff !== null && vLiftoff >= 28 && vLiftoff <= 40, f1(vLiftoff) + ' m/s');
  check('climbs: agl > 80 m and vs > 1 m/s at 60 s', s.agl > 80 && s.vs > 1, 'agl ' + f1(s.agl) + ' vs ' + f2(s.vs));
  check('takeoff event emitted with the runway end', !!takeoffEv && takeoffEv.data && takeoffEv.data.runwayEnd === RWY, takeoffEv ? 'runwayEnd=' + (takeoffEv.data.runwayEnd && takeoffEv.data.runwayEnd.key) : 'no event');
  check('no crash, finite state', !s.crashed && finite(s) && t >= 60, s.crashReason || 'ok');
}

// ---------------------------------------------------------------
// (b) level cruise at full throttle (pilot holds altitude) + hands-off trim
// ---------------------------------------------------------------
console.log('\n[b] level cruise');
ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 55, throttle: 1, flaps: 0 });
{
  const s = ac.state;
  run(150, altHold(600));
  const vFull = s.airspeed, altFull = s.altitude;
  console.log('  full throttle, altitude held: airspeed ' + f1(s.airspeed) + ' m/s (' + kt(s.airspeed) + '), alt ' + f1(s.altitude) + ' m, pitch ' + f1(s.pitch) + '°, alpha ' + f1(s.alpha) + '°, elevator ' + f2(s.elevator) + ', g ' + f2(s.gForce) + ', rpm ' + s.rpm.toFixed(0));
  check('full-throttle level cruise between 58 and 68 m/s', vFull > 58 && vFull < 68, f1(vFull) + ' m/s');
  check('altitude held within 30 m', Math.abs(altFull - 600) < 30, f1(altFull) + ' m');
  check('g ~ 1 in level flight', Math.abs(s.gForce - 1) < 0.1, f2(s.gForce));
  ac.setThrottle(0.7);
  run(150, altHold(600));
  console.log('  70 % throttle: airspeed ' + f1(s.airspeed) + ' m/s (' + kt(s.airspeed) + ')');
  check('70 % throttle cruise between 48 and 60 m/s', s.airspeed > 48 && s.airspeed < 60, f1(s.airspeed) + ' m/s');
  // hands-off: stick centered, full throttle, from cruise
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 60, throttle: 1, flaps: 0 });
  stick(0, 0, 0);
  let vMin = 1e9, vMax = 0, pMin = 1e9, pMax = -1e9;
  run(120, (st, time) => { if (time > 60) { vMin = Math.min(vMin, st.airspeed); vMax = Math.max(vMax, st.airspeed); pMin = Math.min(pMin, st.pitch); pMax = Math.max(pMax, st.pitch); } });
  console.log('  hands-off full throttle (last 60 s): airspeed ' + f1(vMin) + '..' + f1(vMax) + ' m/s, pitch ' + f1(pMin) + '..' + f1(pMax) + '°, vs ' + f2(s.vs) + ' m/s, roll ' + f1(s.roll) + '°');
  check('hands-off trims to a sane band (35..70 m/s), wings level', vMin > 35 && vMax < 70 && Math.abs(s.roll) < 3, f1(vMin) + '..' + f1(vMax) + ' m/s');
  check('no stall / crash hands-off', !s.crashed && !s.stall && finite(s), s.crashReason || 'ok');
}

// ---------------------------------------------------------------
// (b2) hands-off after reset at 120 m / 50 m/s / 70 % throttle (integration scenario): must settle to ~level flight
// ---------------------------------------------------------------
console.log('\n[b2] hands-off after reset (120 m, 50 m/s, 70 % throttle)');
events.length = 0;
ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 120, speed: 50, throttle: 0.7, flaps: 0 });
ac.update(DT);
check('reset emits only the reset event (no touchdown / crash)', events.length === 1 && events[0].name === 'reset', events.map((e) => e.name).join(','));
{
  const s = ac.state;
  stick(0, 0, 0);
  const samples = []; let vsMaxLate = 0, pMin = 99, pMax = -99, altMin = 1e9;
  run(40, (st, time) => {
    if (Math.abs(time - Math.round(time)) < DT / 2 && Math.round(time) % 5 === 0) samples.push('t' + time.toFixed(0) + ': vs ' + st.vs.toFixed(2) + ' pitch ' + st.pitch.toFixed(1) + ' V ' + st.airspeed.toFixed(1) + ' alt ' + st.altitude.toFixed(0));
    if (time > 15) { vsMaxLate = Math.max(vsMaxLate, Math.abs(st.vs)); pMin = Math.min(pMin, st.pitch); pMax = Math.max(pMax, st.pitch); }
    altMin = Math.min(altMin, st.altitude);
  });
  console.log('  ' + samples.join('\n  '));
  check('hands-off: |vs| < 2 m/s after 15 s, pitch within -2..6 deg', vsMaxLate < 2 && pMin > -2 && pMax < 6, 'vs max ' + f2(vsMaxLate) + ' pitch ' + f1(pMin) + '..' + f1(pMax));
  check('hands-off: never lost more than 15 m, no crash', altMin > 105 && !s.crashed, 'min alt ' + f1(altMin));
  ac.setThrottle(0.6); run(30);
  console.log('  60 % throttle after 30 s: vs ' + f2(s.vs) + ' pitch ' + f1(s.pitch) + ' V ' + f1(s.airspeed));
  check('hands-off at 60 %: still ~level', Math.abs(s.vs) < 1.5 && s.pitch > -2 && s.pitch < 6, f2(s.vs));
}

// ---------------------------------------------------------------
// (c) idle glide from 500 m
// ---------------------------------------------------------------
console.log('\n[c] idle glide from 500 m');
ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 500, speed: 33, throttle: 0, flaps: 0 });
{
  const s = ac.state;
  let vsSum = 0, n = 0;
  run(40, (st, time) => { speedHold(33)(st); if (time > 15) { vsSum += st.vs; n++; } });
  const vsAvg = vsSum / n;
  const ld = s.airspeed / -vsAvg;
  console.log('  best-glide pilot (33 m/s): vs avg ' + f2(vsAvg) + ' m/s (' + (vsAvg * 196.85).toFixed(0) + ' ft/min), airspeed ' + f1(s.airspeed) + ' m/s, L/D ' + f1(ld) + ', alpha ' + f1(s.alpha) + '°, alt ' + f1(s.altitude));
  check('glide descent rate between -5 and -2 m/s', vsAvg < -2 && vsAvg > -5, f2(vsAvg) + ' m/s');
  check('glide ratio believable (7..13)', ld > 7 && ld < 13, f1(ld));
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 500, speed: 33, throttle: 0, flaps: 0 });
  stick(0, 0, 0);
  vsSum = 0; n = 0;
  run(50, (st, time) => { if (time > 25) { vsSum += st.vs; n++; } });
  console.log('  hands-off idle glide: vs avg ' + f2(vsSum / n) + ' m/s, airspeed ' + f1(s.airspeed) + ' m/s, pitch ' + f1(s.pitch) + '°');
  check('hands-off glide: descends, no stall, finite', vsSum / n < -1 && vsSum / n > -8 && !s.stall && finite(s), f2(vsSum / n) + ' m/s');
  // full flaps, 35 % throttle at 33 m/s: ~3° approach
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 500, speed: 33, throttle: 0.35, flaps: 1 });
  vsSum = 0; n = 0;
  run(40, (st, time) => { speedHold(33)(st); if (time > 15) { vsSum += st.vs; n++; } });
  const gamma = Math.atan2(-vsSum / n, s.groundSpeed) * 180 / Math.PI;
  console.log('  approach config (flaps full, 35 % throttle, 33 m/s): vs ' + f2(vsSum / n) + ' m/s, path angle ' + f1(gamma) + '°, pitch ' + f1(s.pitch) + '°, alpha ' + f1(s.alpha) + '°');
  check('approach descends at roughly 2..5 degrees', gamma > 1.5 && gamma < 5.5, f1(gamma) + '°');
}

// ---------------------------------------------------------------
// (d) stall: idle, full back stick, then release
// ---------------------------------------------------------------
console.log('\n[d] stall and recovery');
ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 800, speed: 45, throttle: 0, flaps: 0 });
{
  const s = ac.state;
  let stalled = false, maxAlpha = 0, minSpeed = 1e9, minPitch = 1e9, tStall = null, maxRate = 0;
  const trace = [];
  run(25, (st, time) => {
    stick(time < 14 ? 1 : 0, 0, 0);
    if (Math.abs(time / 1 - Math.round(time / 1)) < DT / 2) trace.push('t' + time.toFixed(0) + ':V' + st.airspeed.toFixed(0) + '/a' + st.alpha.toFixed(0) + '/p' + st.pitch.toFixed(0) + '/vs' + st.vs.toFixed(0));
    if (st.stall && !stalled) { stalled = true; tStall = time; }
    if (st.alpha > maxAlpha) maxAlpha = st.alpha;
    if (st.airspeed < minSpeed) minSpeed = st.airspeed;
    if (stalled && st.pitch < minPitch) minPitch = st.pitch;
    maxRate = Math.max(maxRate, Math.abs(st.vs));
  });
  console.log('  trace (V m/s / alpha / pitch / vs): ' + trace.join(' '));
  console.log('  stall flagged at t=' + f1(tStall) + ' s, max alpha ' + f1(maxAlpha) + '°, min speed ' + f1(minSpeed) + ' m/s (' + kt(minSpeed) + '), lowest pitch after stall ' + f1(minPitch) + '°, final: speed ' + f1(s.airspeed) + ' pitch ' + f1(s.pitch) + ' alt ' + f1(s.altitude) + ' stall=' + s.stall);
  check('stall (speed below stall speed) occurs with full back stick at idle', stalled && minSpeed < 24, 'max alpha ' + f1(maxAlpha) + ' min speed ' + f1(minSpeed));
  check('nose lowers in the stall, no loop', minPitch < 5 && minPitch > -45, 'min pitch ' + f1(minPitch) + '°');
  check('recovers after release: speed > 30 m/s, not stalled, finite', s.airspeed > 30 && !s.stall && finite(s) && !s.crashed, f1(s.airspeed) + ' m/s');
  // informational: gentle approach-to-stall (idle, pilot tries to hold altitude), then hands off
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 800, speed: 40, throttle: 0, flaps: 0 });
  const tr2 = []; let tS = null, pitchAtStall = null, minP2 = 99, minV2 = 99;
  const holdAlt = altHold(800);
  run(75, (st, time) => {
    if (tS === null) holdAlt(st); else stick(0, 0, 0);
    if (st.stall && tS === null) { tS = time; pitchAtStall = st.pitch; }
    if (tS !== null) { minP2 = Math.min(minP2, st.pitch); minV2 = Math.min(minV2, st.airspeed); }
    if (Math.abs(time - Math.round(time)) < DT / 2 && Math.round(time) % 4 === 0) tr2.push('t' + time.toFixed(0) + ':V' + st.airspeed.toFixed(0) + '/a' + st.alpha.toFixed(0) + '/p' + st.pitch.toFixed(0) + '/vs' + st.vs.toFixed(0));
  });
  console.log('  gentle stall (idle, altitude hold until the break, then hands off): stall at t=' + f1(tS) + ' s, pitch at stall ' + f1(pitchAtStall) + '°, min pitch after ' + f1(minP2) + '°, min speed ' + f1(minV2) + ' m/s, end speed ' + f1(s.airspeed) + ' alt lost ' + f1(800 - s.altitude) + ' m');
  console.log('  trace: ' + tr2.join(' '));
  check('slow deceleration at idle ends in a stall-edge mush (alpha 12..15, 24..31 m/s), no crash', s.alpha > 12 && s.alpha < 15.5 && s.airspeed > 24 && s.airspeed < 31 && !s.crashed && s.vs > -6, 'a ' + f1(s.alpha) + ' V ' + f1(s.airspeed) + ' vs ' + f2(s.vs) + (tS !== null ? ' (stall flag at ' + f1(tS) + ' s)' : ''));
}

// ---------------------------------------------------------------
// (e) roll / yaw rates and return-to-level
// ---------------------------------------------------------------
console.log('\n[e] roll and yaw response at cruise');
ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 60, throttle: 0.75, flaps: 0 });
{
  const s = ac.state;
  let r0 = 0;
  run(1, () => stick(0, 1, 0));
  r0 = s.roll;
  run(0.5, () => stick(0, 1, 0));
  const rollRate = (s.roll - r0) / 0.5;
  console.log('  full right aileron: roll rate ' + f1(rollRate) + ' deg/s (target ~70), bank ' + f1(s.roll) + '°');
  check('full aileron roll rate 45..95 deg/s at cruise', rollRate > 45 && rollRate < 95, f1(rollRate));
  // release from a 30 deg bank: should ease back toward level
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 60, throttle: 0.75, flaps: 0 });
  ac.setAttitude(0, 2, 30);
  stick(0, 0, 0);
  run(6);
  console.log('  released at 30° bank, 6 s later: bank ' + f1(s.roll) + '° (level assist ~3 deg/s)');
  check('return-to-level assist reduces bank', s.roll < 20 && s.roll > 0, f1(s.roll) + '°');
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 60, throttle: 0.75, flaps: 0 });
  const h0 = s.heading;
  run(3, () => stick(0, 0, 1));
  const dh = FS.geo.wrap180(s.heading - h0);
  console.log('  full right rudder for 3 s: heading change ' + f1(dh) + '°, beta ' + f1(s.beta) + '°, roll ' + f1(s.roll) + '° (dihedral)');
  check('rudder yaws right and induces a sideslip', dh > 3 && s.beta !== 0, 'dh ' + f1(dh));
  // pitch rate with full elevator at cruise
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 60, throttle: 0.75, flaps: 0 });
  let maxG = 0, maxQ = 0, lastPitch = s.pitch;
  run(1.5, (st) => { stick(1, 0, 0); maxG = Math.max(maxG, st.gForce); maxQ = Math.max(maxQ, (st.pitch - lastPitch) / DT); lastPitch = st.pitch; });
  console.log('  full back stick at 60 m/s: peak pitch rate ' + f1(maxQ) + ' deg/s (target ~25), peak g ' + f2(maxG));
  check('full elevator pitch rate 4..13 deg/s at cruise (arcade limit ~12)', maxQ > 4 && maxQ < 13, f1(maxQ));
  check('pull-up g between 1.2 and 2.3', maxG > 1.2 && maxG < 2.3, f2(maxG));
  // sustained full back stick at 97 kt, full throttle: must not loop; settles near a stall-edge climb attitude
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 600, speed: 50, throttle: 1, flaps: 0 });
  let maxPitch = -99, maxQ2 = 0, lp = s.pitch; const tr3 = [];
  run(30, (st, time) => { stick(1, 0, 0); maxPitch = Math.max(maxPitch, st.pitch); maxQ2 = Math.max(maxQ2, (st.pitch - lp) / DT); lp = st.pitch;
    if (Math.abs(time - Math.round(time)) < DT / 2 && Math.round(time) % 3 === 0) tr3.push('t' + time.toFixed(0) + ':V' + st.airspeed.toFixed(0) + '/a' + st.alpha.toFixed(0) + '/p' + st.pitch.toFixed(0)); });
  console.log('  sustained full back stick from 97 kt, full throttle: max pitch ' + f1(maxPitch) + '°, peak rate ' + f1(maxQ2) + ' deg/s; at 30 s: V ' + f1(s.airspeed) + ' m/s, alpha ' + f1(s.alpha) + '°, pitch ' + f1(s.pitch) + '°, vs ' + f2(s.vs) + ', stall=' + s.stall);
  console.log('  trace: ' + tr3.join(' '));
  check('no loop: max pitch < 50 deg, peak pitch rate < 13 deg/s', maxPitch < 50 && maxQ2 < 13, f1(maxPitch) + '° / ' + f1(maxQ2));
  check('settles at a stall-edge climb: alpha 11..16, pitch 8..30, speed 23..32', s.alpha > 11 && s.alpha < 16 && s.pitch > 8 && s.pitch < 30 && s.airspeed > 23 && s.airspeed < 32 && !s.crashed, 'a ' + f1(s.alpha) + ' p ' + f1(s.pitch) + ' V ' + f1(s.airspeed));
}

// ---------------------------------------------------------------
// (f) landing: 3° approach, flare, touchdown event
// ---------------------------------------------------------------
console.log('\n[f] landing on runway 10');
events.length = 0;
{
  const s = ac.state;
  const d = 2500;
  const x = RWY.threshold.x - RWY.dir.x * d, z = RWY.threshold.z - RWY.dir.z * d;
  const alt = RWY.elev + 15 + d * Math.tan(3 * Math.PI / 180);
  ac.reset({ x, z, altitude: alt, heading: 96, onGround: false, speed: 33, throttle: 0.4, flaps: 1 });
  let touched = null, minAgl = 1e9;
  const t = run(120, (st) => {
    if (touched === null) {
      const rx = st.pos.x - RWY.threshold.x, rz = st.pos.z - RWY.threshold.z;
      const along = rx * RWY.dir.x + rz * RWY.dir.z;
      // glideslope: desired altitude along a 3° path to a 15 m threshold crossing height; flare below 8 m agl
      const desired = RWY.elev + 15 + Math.max(0, -along) * Math.tan(3 * Math.PI / 180);
      const agl = st.agl;
      if (agl > 8) {
        const err = desired - st.altitude;
        const vsCmd = Math.max(-3.5, Math.min(1, err * 0.2 - 1.7));
        stick(Math.max(-1, Math.min(1, (vsCmd - st.vs) * 0.15)), 0, 0);
        ac.setThrottle(st.airspeed > 33 ? 0.3 : 0.45);
      } else {
        ac.setThrottle(0);
        const vsCmd = Math.max(-1.0, -0.15 * agl - 0.3);
        stick(Math.max(-1, Math.min(1, (vsCmd - st.vs) * 0.25 + 0.15)), 0, 0);
      }
      minAgl = Math.min(minAgl, agl);
      if (st.onGround) { touched = events.find((e) => e.name === 'touchdown'); ac.setBrakes(true); stick(0, 0, 0); }
    }
  });
  const td = touched && touched.data;
  console.log('  touchdown: ' + (td ? 'vs ' + f2(td.vs) + ' m/s, speed ' + f1(td.speed) + ' m/s, alongFromThreshold ' + f1(td.alongFromThreshold) + ' m, crossTrack ' + f2(td.crossTrack) + ' m, runwayEnd ' + (td.runwayEnd && td.runwayEnd.key) + ', landingEnd ' + (td.landingEnd && td.landingEnd.key) + ', hard=' + td.hard : 'none') + '; crashed=' + s.crashed + (s.crashed ? ' (' + s.crashReason + ')' : ''));
  console.log('  after rollout (brakes): ground speed ' + f2(s.groundSpeed) + ' m/s, onGround=' + s.onGround + ', onRunway=' + (s.onRunway && s.onRunway.key));
  check('touchdown event fired, no crash', !!td && !s.crashed, td ? 'vs ' + f2(td.vs) : (s.crashReason || 'no touchdown'));
  check('touchdown on the runway with sane geometry', !!td && td.runwayEnd === RWY && td.landingEnd === RWY && td.alongFromThreshold > 0 && td.alongFromThreshold < 1500 && Math.abs(td.crossTrack) < 5, td ? f1(td.alongFromThreshold) + ' m / ' + f2(td.crossTrack) + ' m' : '-');
  check('brakes stop the aircraft on the runway', s.onGround && s.groundSpeed < 0.5 && !!s.onRunway, f2(s.groundSpeed) + ' m/s');
  // westbound landing on the same runway must resolve landingEnd to runway 28 (heading match), runwayEnd stays the first end
  events.length = 0;
  const x2 = RWY28.threshold.x - RWY28.dir.x * d, z2 = RWY28.threshold.z - RWY28.dir.z * d;
  ac.reset({ x: x2, z: z2, altitude: alt, heading: 276, onGround: false, speed: 33, throttle: 0.4, flaps: 1 });
  run(120, (st) => {
    if (st.onGround) { stick(0, 0, 0); ac.setBrakes(true); return; }
    const rx = st.pos.x - RWY28.threshold.x, rz = st.pos.z - RWY28.threshold.z;
    const along = rx * RWY28.dir.x + rz * RWY28.dir.z;
    const desired = RWY.elev + 15 + Math.max(0, -along) * Math.tan(3 * Math.PI / 180);
    if (st.agl > 8) { const err = desired - st.altitude; vsHold(Math.max(-3.5, Math.min(1, err * 0.2 - 1.7)), 0.15)(st); ac.setThrottle(st.airspeed > 33 ? 0.3 : 0.45); }
    else { ac.setThrottle(0); vsHold(Math.max(-1.0, -0.15 * st.agl - 0.3), 0.25)(st); }
  });
  const td28 = events.find((e) => e.name === 'touchdown');
  console.log('  westbound touchdown: ' + (td28 ? 'runwayEnd ' + (td28.data.runwayEnd && td28.data.runwayEnd.key) + ', landingEnd ' + (td28.data.landingEnd && td28.data.landingEnd.key) + ', along ' + f1(td28.data.alongFromThreshold) + ' m, cross ' + f2(td28.data.crossTrack) + ' m, vs ' + f2(td28.data.vs) : 'none') + (s.crashed ? ' CRASH ' + s.crashReason : ''));
  check('westbound landing resolves landingEnd = RCSS-28 with along measured from its threshold', !!td28 && td28.data.landingEnd === RWY28 && td28.data.alongFromThreshold > 0 && td28.data.alongFromThreshold < 1500 && !s.crashed, td28 ? f1(td28.data.alongFromThreshold) + ' m' : '-');
}

// ---------------------------------------------------------------
// (g) crashes: hard impact, water, building, world limit, off-airport speed
// ---------------------------------------------------------------
console.log('\n[g] crash detection');
{
  const s = ac.state;
  events.length = 0;
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 200, speed: 50, throttle: 0.5, flaps: 0 });
  run(30, () => stick(-1, 0, 0));
  const ev = events.find((e) => e.name === 'crash');
  console.log('  dive into the ground: crashed=' + s.crashed + ' reason="' + s.crashReason + '"');
  check('diving into terrain crashes with a crash event', s.crashed && !!ev && ev.data.reason === s.crashReason, s.crashReason);
  runRaw(5); // crash animation must stay finite
  check('crash animation finite, engine stops', finite(s) && s.rpm < 100 && s.throttle === 0, 'rpm ' + s.rpm.toFixed(0));
  // reset clears the crash
  ac.reset({ x: 0, z: 0, heading: 0, onGround: true });
  check('reset clears the crash and emits reset', !s.crashed && s.crashReason === '' && s.onGround && events.some((e) => e.name === 'reset'), '');
  // water
  world.water = true;
  ac.reset({ x: 0, z: 0, heading: 0, onGround: false, altitude: 60, speed: 30, throttle: 0, flaps: 1 });
  run(40, () => stick(0.3, 0, 0));
  console.log('  glide onto water: reason="' + s.crashReason + '"');
  check('water contact = ditching crash', s.crashed && /water/i.test(s.crashReason), s.crashReason);
  world.water = false;
  // building
  FS.city.getObstacleTop = (x, z) => (Math.abs(x - 1500) < 100 && Math.abs(z + 0) < 100 ? 300 : -Infinity);
  ac.reset({ x: 0, z: 0, heading: 90, onGround: false, altitude: 250, speed: 55, throttle: 0.7, flaps: 0 });
  run(40, altHold(250));
  console.log('  flying into a 300 m tower at 250 m: reason="' + s.crashReason + '"');
  check('building strike detected', s.crashed && /building/i.test(s.crashReason), s.crashReason);
  FS.city.getObstacleTop = () => -Infinity;
  // fast contact off airport (flat grass)
  ac.reset({ x: 20000, z: 20000, heading: 0, onGround: false, altitude: FIELD_ELEV + 30, speed: 55, throttle: 0.3, flaps: 0 });
  run(60, vsHold(-1.5));
  console.log('  fast contact off-airport: reason="' + s.crashReason + '" (speed ' + f1(s.groundSpeed) + ' m/s)');
  check('off-airport contact > 30 m/s crashes', s.crashed && /off-airport|ground/i.test(s.crashReason), s.crashReason);
  // hard but survivable arrival: idle, full flaps, ~-5 m/s at contact
  events.length = 0;
  ac.reset({ x: RWY.center.x - RWY.dir.x * 300, z: RWY.center.z - RWY.dir.z * 300, heading: 96, onGround: false, altitude: FIELD_ELEV + 12, speed: 27, throttle: 0, flaps: 1 });
  run(30, vsHold(-3.6, 0.3));
  const tdHard = events.find((e) => e.name === 'touchdown');
  console.log('  hard arrival: ' + (tdHard ? 'touchdown vs ' + f2(tdHard.data.vs) + ' hard=' + tdHard.data.hard : 'no touchdown') + ', crashed=' + s.crashed + ' ' + s.crashReason + ', touchdown events ' + events.filter((e) => e.name === 'touchdown').length);
  check('-2.5..-6.5 m/s contact = hard landing event, bounce, no crash, single event', !!tdHard && tdHard.data.hard === true && tdHard.data.vs < -2.5 && tdHard.data.vs > -6.5 && !s.crashed && s.onGround && events.filter((e) => e.name === 'touchdown').length === 1, s.crashReason || (tdHard ? f2(tdHard.data.vs) : '-'));
  // slow contact off airport survives
  ac.reset({ x: 20000, z: 20000, heading: 0, onGround: false, altitude: FIELD_ELEV + 20, speed: 28, throttle: 0.3, flaps: 1 });
  events.length = 0;
  run(40, (st) => { vsHold(st.agl > 5 ? -1.5 : -0.7)(st); if (st.onGround) ac.setThrottle(0); });
  const td2 = events.find((e) => e.name === 'touchdown');
  console.log('  slow field landing off-airport: crashed=' + s.crashed + ' touchdown=' + (td2 ? 'vs ' + f2(td2.data.vs) + ' speed ' + f1(td2.data.speed) + ' runwayEnd=' + td2.data.runwayEnd : 'none'));
  check('slow flat-field landing survives (touchdown, no runway)', !s.crashed && !!td2 && td2.data.runwayEnd === null, s.crashReason || 'ok');
  // slope
  world.slopeX = Math.tan(12 * Math.PI / 180);
  ac.reset({ x: RWY.center.x, z: RWY.center.z, heading: 0, onGround: false, altitude: FIELD_ELEV + 20, speed: 28, throttle: 0.3, flaps: 1 });
  run(40, vsHold(-1.0));
  console.log('  landing on a 12° slope: reason="' + s.crashReason + '"');
  check('sloped terrain contact crashes', s.crashed && /terrain/i.test(s.crashReason), s.crashReason);
  world.slopeX = 0;
  // world limit
  ac.reset({ x: 39900, z: 0, heading: 90, onGround: false, altitude: 1000, speed: 60, throttle: 1, flaps: 0 });
  run(10, altHold(1000));
  check('leaving the world crashes', s.crashed && /Taipei/i.test(s.crashReason), s.crashReason);
}

// ---------------------------------------------------------------
// (h) ground handling: steering, brakes, no self-liftoff, parking
// ---------------------------------------------------------------
console.log('\n[h] ground handling');
{
  const s = ac.state;
  ac.reset({ x: RWY.spawn.x, z: RWY.spawn.z, heading: 96, onGround: true, speed: 0, throttle: 0, flaps: 0 });
  ac.setThrottle(0.5);
  run(6, () => stick(0, 0, 0));
  const v6 = s.groundSpeed, h0 = s.heading;
  run(3, () => stick(0, 0, 1));
  const dh = FS.geo.wrap180(s.heading - h0);
  console.log('  taxi at 50 %: speed after 6 s ' + f1(v6) + ' m/s; right rudder 3 s at ~' + f1(s.groundSpeed) + ' m/s turned ' + f1(dh) + '°, roll ' + f2(s.roll) + '° pitch ' + f2(s.pitch) + '°');
  check('nose-wheel steering turns right with right rudder', dh > 20, f1(dh) + '°');
  check('stays level on the ground', Math.abs(s.roll) < 1 && Math.abs(s.pitch) < 1 && s.onGround, '');
  ac.setThrottle(0);
  FS.input.keys.add('Space');
  run(8, () => stick(0, 0, 0));
  FS.input.keys.delete('Space');
  console.log('  Space brake: speed ' + f2(s.groundSpeed) + ' m/s after 8 s');
  check('brakes (Space) stop the aircraft', s.groundSpeed < 0.2, f2(s.groundSpeed));
  // full throttle, stick neutral: must not lift off by itself before the runway ends? (it may fly off at high speed) — check no nose-drop crash & sane pitch
  ac.reset({ x: RWY.spawn.x, z: RWY.spawn.z, heading: 96, onGround: true, speed: 0, throttle: 0, flaps: 0 });
  ac.setThrottle(1);
  let maxP = -99, minP = 99;
  run(20, (st) => { stick(0, 0, 0); if (st.onGround) { maxP = Math.max(maxP, st.pitch); minP = Math.min(minP, st.pitch); } });
  console.log('  full throttle, neutral stick for 20 s: speed ' + f1(s.airspeed) + ' m/s, onGround=' + s.onGround + ', ground pitch range ' + f1(minP) + '..' + f1(maxP) + '°, heading ' + f1(s.heading) + '°');
  check('neutral-stick roll keeps the nose down (pitch < 4°) and tracks the runway', maxP < 4 && Math.abs(FS.geo.wrap180(s.heading - 96)) < 3 && !s.crashed, '');
  // parking brake toggle with B
  ac.reset({ x: RWY.spawn.x, z: RWY.spawn.z, heading: 96, onGround: true, speed: 0, throttle: 0, flaps: 0 });
  FS.input.pressed.add('KeyB'); ac.update(DT); FS.input.pressed.delete('KeyB');
  ac.setThrottle(1);
  run(5, () => stick(0, 0, 0));
  console.log('  parking brake + full throttle 5 s: speed ' + f2(s.groundSpeed) + ' m/s, brakes=' + s.brakes);
  check('parking brake holds against partial power (speed < 4 m/s)', s.brakes === true && s.groundSpeed < 4, f2(s.groundSpeed));
  // flaps cycle with F
  ac.reset({ x: RWY.spawn.x, z: RWY.spawn.z, heading: 96, onGround: true });
  const seq = [];
  for (let i = 0; i < 3; i++) { FS.input.pressed.add('KeyF'); ac.update(DT); FS.input.pressed.delete('KeyF'); seq.push(s.flaps); }
  check('F cycles flaps 0 -> 0.5 -> 1 -> 0', seq.join(',') === '0.5,1,0', seq.join(','));
  run(5);
  check('flap position travels (0.25/s)', s.flapPos === 0, 'pos ' + f2(s.flapPos));
}

// ---------------------------------------------------------------
console.log('\n' + (failures ? failures + ' check(s) FAILED' : 'all ' + results.length + ' checks passed'));
process.exit(failures ? 1 : 0);
