/* Headless math test for js/nav.js (node test/nav-math.js).
   Stubs window, a minimal THREE (or the real three@0.128.0 when NAV_TEST_THREE points at a module path),
   FS.airports (RCSS 10/28 computed from FS.CONFIG exactly as the contract defines them), FS.aircraft, FS.world, FS.city. */
'use strict';
const path = require('path');

// ---- environment -------------------------------------------------------
global.window = global;
global.THREE = loadThree();
require(path.join(__dirname, '..', 'js', 'config.js'));
const FS = window.FS, G = FS.geo, D2R = Math.PI / 180;

function loadThree() {
  const p = process.env.NAV_TEST_THREE;
  if (p) { try { const t = require(p); console.log('Using real three ' + t.REVISION + ' from ' + p); return t; } catch (e) { console.log('Real three not loadable (' + e.message + '), using stub'); } }
  return makeStubThree();
}
function makeStubThree() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vector3(this.x, this.y, this.z); }
  }
  class Color {
    constructor(hex) { this.r = 1; this.g = 1; this.b = 1; if (typeof hex === 'string') { const n = parseInt(hex.slice(1), 16); this.r = ((n >> 16) & 255) / 255; this.g = ((n >> 8) & 255) / 255; this.b = (n & 255) / 255; } }
    convertSRGBToLinear() { return this; }
    clone() { const c = new Color(); c.r = this.r; c.g = this.g; c.b = this.b; return c; }
    copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; }
  }
  class Object3D {
    constructor() { this.position = new Vector3(); this.rotation = { x: 0, y: 0, z: 0 }; this.scale = new Vector3(1, 1, 1); this.children = []; this.visible = true; this.parent = null; this.name = ''; this.renderOrder = 0; }
    add(o) { o.parent = this; this.children.push(o); return this; }
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) { this.children.splice(i, 1); o.parent = null; } return this; }
    traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  }
  class Group extends Object3D {}
  class Mesh extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
  class BufferGeometry { constructor() { this.attributes = {}; this.index = null; } setAttribute(n, a) { this.attributes[n] = a; return this; } setIndex(i) { this.index = i; return this; } computeBoundingSphere() {} dispose() {} }
  class TorusGeometry extends BufferGeometry { constructor(r, t, rs, ts) { super(); this.parameters = { radius: r, tube: t, radialSegments: rs, tubularSegments: ts }; } }
  class Float32BufferAttribute { constructor(arr, size) { this.array = Float32Array.from(arr); this.itemSize = size; this.count = arr.length / size; } }
  class MeshBasicMaterial { constructor(p) { Object.assign(this, p || {}); if (!this.color) this.color = new Color('#ffffff'); } dispose() {} }
  class Scene extends Object3D {}
  return { Vector3, Color, Object3D, Group, Mesh, Scene, BufferGeometry, TorusGeometry, Float32BufferAttribute, MeshBasicMaterial, DoubleSide: 2, REVISION: 'stub' };
}

// ---- runway ends from FS.CONFIG, exactly as CONTRACT.md defines them -----
function makeEnds() {
  const out = [];
  for (const ap of FS.CONFIG.airports) {
    for (const rw of ap.runways) {
      const mk = (id, heading) => {
        const dir = G.headingToDir(heading);
        const threshold = { x: rw.cx - dir.x * rw.length / 2, z: rw.cz - dir.z * rw.length / 2 };
        const oppositeThreshold = { x: rw.cx + dir.x * rw.length / 2, z: rw.cz + dir.z * rw.length / 2 };
        const perp = { x: -dir.z, z: dir.x };
        return {
          key: ap.icao + '-' + id, icao: ap.icao, airportName: ap.name, id, heading, dir, threshold, oppositeThreshold,
          tdz: { x: threshold.x + dir.x * 300, z: threshold.z + dir.z * 300 }, center: { x: rw.cx, z: rw.cz },
          elev: ap.elev, length: rw.length, width: rw.width,
          spawn: { x: threshold.x + dir.x * 150, z: threshold.z + dir.z * 150, heading },
          papi: { x: threshold.x + dir.x * 300 - perp.x * 50, z: threshold.z + dir.z * 300 - perp.z * 50, side: 'left' },
        };
      };
      out.push(mk(rw.id, rw.heading), mk(rw.recip, G.wrap360(rw.heading + 180)));
    }
  }
  return out;
}
const ENDS = makeEnds();
const RCSS10 = ENDS.find((e) => e.key === 'RCSS-10'), RCSS28 = ENDS.find((e) => e.key === 'RCSS-28');
FS.airports = { getRunwayEnds: () => ENDS, getRunwayEnd: (k) => ENDS.find((e) => e.key === k) };
FS.world = { getHeight: () => 5.5, getGroundCanvases: () => [] };
FS.city = { landmarks: [], getObstacleTop: () => -Infinity };
FS.hud = { showMessage: () => {} };
const state = {
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), heading: 0, altitude: 0, agl: 0, airspeed: 40, groundSpeed: 40,
  onGround: false, onRunway: null, vs: 0, pitch: 0, roll: 0, crashed: false,
};
FS.aircraft = { state, params: { vSpeeds: { rotate: 28, approach: 33, stall: 24, stallFlaps: 21, cruise: 60, never: 82 } } };

require(path.join(__dirname, '..', 'js', 'nav.js'));
const nav = FS.nav;
const scene = new THREE.Scene();
nav.init(scene);

// ---- helpers --------------------------------------------------------------
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : '')); }
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }
function place(E, distShort, right, altOffset, heading, extra) {
  const p = { x: -E.dir.z, z: E.dir.x };
  state.pos.set(E.threshold.x - E.dir.x * distShort + p.x * right, 0, E.threshold.z - E.dir.z * distShort + p.z * right);
  const alt = E.elev + 15 + Math.max(distShort, 0) * Math.tan(3 * D2R) + (altOffset || 0);
  state.pos.y = alt; state.altitude = alt; state.agl = alt - 5.5;
  state.heading = heading == null ? E.heading : heading;
  state.onGround = false; state.vs = 0; state.airspeed = 36; state.groundSpeed = 36;
  Object.assign(state, extra || {});
}
function step(n, dt) { for (let i = 0; i < n; i++) nav.update(dt || 0.016); return nav.guidance; }
const warnings = [];
const origWarn = console.warn; console.warn = (...a) => { warnings.push(a.join(' ')); origWarn.apply(console, a); };

// ---- 1. on the centerline, on the glidepath, 5 km short ------------------
nav.setTarget(RCSS10); nav.setPhase('landing');
place(RCSS10, 5000, 0, 0);
let g = step(1);
console.log('  locDev=' + g.locDev.toFixed(3) + ' gsDev=' + g.gsDev.toFixed(3) + ' dist=' + g.dist.toFixed(0) + ' onFinal=' + g.onFinal + ' est=' + g.established + ' :: ' + g.instruction);
check('5 km short, centerline, on path: |locDev| < 0.1', Math.abs(g.locDev) < 0.1, g.locDev.toFixed(4));
check('5 km short, centerline, on path: |gsDev| < 0.1', Math.abs(g.gsDev) < 0.1, g.gsDev.toFixed(4));
check('dist ~ 5000 m to the threshold', approx(g.dist, 5000, 1), g.dist.toFixed(1));
check('alongTrack ~ -5300 m (before the touchdown zone)', approx(g.alongTrack, -5300, 1), g.alongTrack.toFixed(1));
check('onFinal + established', g.onFinal && g.established);
check('instruction reads on localizer / on glideslope', /On localizer · on glideslope · 2\.7 nm/.test(g.instruction), g.instruction);
check('papi on slope = RRWW', g.papi === 'RRWW', g.papi);
check('speedCue = approach speed on final', g.speedCue === 33, String(g.speedCue));
check('bearing to threshold ~ runway heading', approx(g.bearing, 96, 0.05), g.bearing.toFixed(2));

// ---- 2. 200 m right of the centerline: runway is to the LEFT -> locDev negative
place(RCSS10, 5000, 200, 0);
g = step(1);
const expected = Math.atan2(-200, 5000) * 180 / Math.PI; // -2.29
console.log('  locDev=' + g.locDev.toFixed(3) + ' expected=' + expected.toFixed(3) + ' crossTrack=' + g.crossTrack.toFixed(1) + ' desiredHeading=' + g.desiredHeading.toFixed(1) + ' :: ' + g.instruction);
check('200 m right of centerline: crossTrack = +200', approx(g.crossTrack, 200, 0.5), g.crossTrack.toFixed(2));
check('200 m right of centerline: locDev ~ -2.3 deg (contract: + = runway to your right)', approx(g.locDev, expected, 0.05) && g.locDev < 0, g.locDev.toFixed(3));
check('steer back left: desiredHeading = 096 - 10 = 086', approx(g.desiredHeading, 86, 0.01), g.desiredHeading.toFixed(2));
check('headingError negative (turn left)', g.headingError < 0 && approx(g.headingError, -10, 0.01), g.headingError.toFixed(2));
check('instruction says turn left', /^Turn left to 086°/.test(g.instruction), g.instruction);

// ---- 3. above / below the glideslope -----------------------------------------
place(RCSS10, 5000, 0, 60); g = step(1);
check('60 m high at 5 km: gsDev ~ +0.69 (above)', approx(g.gsDev, Math.atan2(60, 5000) * 180 / Math.PI, 0.01) && g.gsDev > 0, g.gsDev.toFixed(3));
check('papi all white when high', g.papi === 'WWWW', g.papi);
place(RCSS10, 5000, 0, -80); g = step(1);
check('80 m low at 5 km: gsDev negative, instruction says add power', g.gsDev < -0.7 && /below glideslope · add power/.test(g.instruction), g.instruction);
check('papi mostly red when low', g.papi === 'RRRR' || g.papi === 'RRRW', g.papi);

// ---- 4. 20 km away, off to the side: waypoint is the IAF ---------------------
nav.setPhase('free');
place(RCSS10, 20000, 8000, 300, 30);
g = step(1);
const iaf = { x: RCSS10.threshold.x - RCSS10.dir.x * 10000, z: RCSS10.threshold.z - RCSS10.dir.z * 10000, y: RCSS10.elev + 15 + 10000 * Math.tan(3 * D2R) };
console.log('  wp=' + JSON.stringify(g.wp) + ' :: ' + g.instruction);
check('20 km out, 8 km to the side: waypoint is the IAF', g.wp && g.wp.name === 'IAF', g.wp && g.wp.name);
check('IAF = threshold - dir * 10 km', g.wp && approx(g.wp.x, iaf.x, 0.5) && approx(g.wp.z, iaf.z, 0.5));
check('IAF altitude = elev + 15 + 10 km * tan 3 deg (~ elev + 540 m)', g.wp && approx(g.wp.y, iaf.y, 0.5), g.wp && g.wp.y.toFixed(1));
check('not on final, phase stays free (not capturable at 20 km)', !g.onFinal && nav.phase === 'free');
check('speedCue = cruise far out', g.speedCue === 60, String(g.speedCue));
check('instruction uses ft / nm units', /ft/.test(g.instruction) && /nm/.test(g.instruction), g.instruction);

// ---- 5. inside 10 km but behind/beside the runway: downwind point on the aircraft's side
nav.setTarget(RCSS10); nav.setPhase('free');
place(RCSS10, -4000, 1500, 200, 200); // 4 km past the threshold, 1.5 km right
g = step(1);
const perp = { x: -RCSS10.dir.z, z: RCSS10.dir.x };
const dwR = { x: RCSS10.threshold.x - RCSS10.dir.x * 6000 + perp.x * 3000, z: RCSS10.threshold.z - RCSS10.dir.z * 6000 + perp.z * 3000 };
console.log('  wp=' + JSON.stringify(g.wp) + ' :: ' + g.instruction);
check('behind the runway, right side: waypoint DW on the right side', g.wp && g.wp.name === 'DW' && approx(g.wp.x, dwR.x, 0.5) && approx(g.wp.z, dwR.z, 0.5), g.wp && g.wp.name);
place(RCSS10, -4000, -1500, 200, 200); g = step(1);
const dwL = { x: RCSS10.threshold.x - RCSS10.dir.x * 6000 - perp.x * 3000, z: RCSS10.threshold.z - RCSS10.dir.z * 6000 - perp.z * 3000 };
check('behind the runway, left side: waypoint DW on the left side', g.wp && g.wp.name === 'DW' && approx(g.wp.x, dwL.x, 0.5) && approx(g.wp.z, dwL.z, 0.5), g.wp && g.wp.name);
check('DW waypoint never routes through the runway (DW is 6 km before the threshold)', g.wp && approx(-G.alongTrack(g.wp.x, g.wp.z, RCSS10.threshold.x, RCSS10.threshold.z, RCSS10.dir.x, RCSS10.dir.z), 6000, 0.5));
// reaching DW hands over to the IAF
state.pos.set(dwL.x + 100, 340, dwL.z); state.altitude = 340; g = step(1);
check('after reaching DW the next waypoint is the IAF', g.wp && g.wp.name === 'IAF', g.wp && g.wp.name);

// ---- 6. in the cone but not on final: intercept point ahead on the centerline
nav.setTarget(RCSS10); nav.setPhase('free');
place(RCSS10, 7000, 1600, 0, 96); // locDev ~ -12.9 deg (outside the 12 deg final cone)
g = step(1);
console.log('  wp=' + JSON.stringify(g.wp) + ' locDev=' + g.locDev.toFixed(2) + ' :: ' + g.instruction);
check('7 km out, 1.6 km abeam: intercept point on the centerline ahead', g.wp && g.wp.name === 'FINAL' && approx(G.crossTrack(g.wp.x, g.wp.z, RCSS10.threshold.x, RCSS10.threshold.z, RCSS10.dir.x, RCSS10.dir.z), 0, 0.5), g.wp && g.wp.name);
check('intercept point is short of the aircraft along the approach (no backtracking)', g.wp && (-G.alongTrack(g.wp.x, g.wp.z, RCSS10.threshold.x, RCSS10.threshold.z, RCSS10.dir.x, RCSS10.dir.z)) < 7000);

// ---- 7. phase machine: free -> landing with a 2 s dwell -------------------------
nav.setTarget(RCSS10); nav.setPhase('free');
place(RCSS10, 12000, 300, 0, 100);
g = step(1, 0.5);
check('free -> landing does not fire before the 2 s dwell', nav.phase === 'free', nav.phase);
g = step(6, 0.5);
check('free -> landing after dwell when within 15 km and aligned', nav.phase === 'landing', nav.phase);
// landing -> free when leaving the approach (heading away)
place(RCSS10, 8000, 0, 0, 96 + 150); g = step(6, 0.5);
check('landing -> free when the aircraft turns away (> 100 deg off)', nav.phase === 'free', nav.phase);

// ---- 8. takeoff -> free, departure gates -----------------------------------------
nav.setTarget(RCSS10); nav.setPhase('takeoff');
state.pos.set(RCSS10.spawn.x, 7, RCSS10.spawn.z); state.altitude = 7; state.agl = 1.5; state.heading = 96; state.onGround = true; state.airspeed = 0; state.groundSpeed = 0;
g = step(1);
console.log('  takeoff: ' + g.instruction + ' | gates ' + g.gates.total + ' next=' + JSON.stringify(g.gates.next));
check('takeoff on the runway: instruction line up / rotate at 55 kt', /Line up · full throttle · rotate at 55 kt/.test(g.instruction), g.instruction);
check('takeoff: 6 departure gates, next is gate 1', g.gates.total === 6 && g.gates.index === 0 && g.gates.set === 'departure');
check('takeoff: speedCue = rotate speed on the ground', g.speedCue === 28, String(g.speedCue));
check('takeoff: desiredHeading = runway heading', approx(g.desiredHeading, 96, 0.5), g.desiredHeading.toFixed(1));
state.airspeed = 30; g = step(1);
check('at rotate speed: Rotate', /^Rotate/.test(g.instruction), g.instruction);
// airborne, 3 km from the center, 200 m AGL -> free after dwell, departure guidance continues
const c = RCSS10.center;
state.onGround = false; state.pos.set(c.x + RCSS10.dir.x * 3000, 210, c.z + RCSS10.dir.z * 3000); state.altitude = 210; state.agl = 204; state.airspeed = 40;
g = step(6, 0.5);
check('takeoff -> free once airborne, > 2 km from the runway center and > 150 m AGL', nav.phase === 'free', nav.phase);
check('departure guidance continues in free while gates remain ahead', /Climb straight ahead to 1,500 ft/.test(g.instruction) && g.gates.set === 'departure', g.instruction);
check('target kept after takeoff', nav.target === RCSS10);

// ---- 9. gate pass detection along the glidepath -----------------------------------
let passed = 0, missed = 0;
FS.events.on('gatePassed', () => passed++);
FS.events.on('gateMissed', () => missed++);
nav.setTarget(RCSS10); nav.setPhase('landing');
for (let d = 9600; d >= 200; d -= 25) { place(RCSS10, d, 0, 0); nav.update(0.016); }
console.log('  gates passed=' + passed + ' missed=' + missed + ' guidance.gates=' + JSON.stringify(nav.guidance.gates));
check('flying the glidepath passes all 13 approach gates', passed === 13 && missed === 0, passed + '/' + missed);
check('guidance.gates reports 13 total / 13 passed', nav.guidance.gates.total === 13 && nav.guidance.gates.passed === 13);
passed = 0; missed = 0;
nav.setPhase('landing'); // resets ring states
for (let d = 9600; d >= 200; d -= 25) { place(RCSS10, d, 60, 0); nav.update(0.016); } // 60 m right of the centerline: outside every ring (r <= 36)
check('flying 60 m off the centerline misses all 13 gates', missed === 13 && passed === 0, passed + '/' + missed);
check('flare instruction below 100 ft on short final', /Flare · idle · hold centerline/.test(nav.guidance.instruction), nav.guidance.instruction);

// ---- 10. landed / rolled out ---------------------------------------------------------
place(RCSS10, -400, 0, 0); state.onGround = true; state.altitude = 7; state.agl = 1.5; state.airspeed = 20; state.groundSpeed = 20;
g = step(1);
check('on the runway past the threshold: landed, brakes instruction', g.landed && /Brakes/.test(g.instruction), g.instruction);
state.airspeed = 0; state.groundSpeed = 0; g = step(1);
check('stopped: rolled out message names the airport', g.rolledOut && /Rolled out · welcome to Taipei Songshan/.test(g.instruction), g.instruction);

// ---- 11. autoTarget / cycleTarget ---------------------------------------------------
state.onGround = false;
place(RCSS28, 6000, 0, 0, 276); // 6 km east of the airport heading west
check('autoTarget prefers the aligned end (RCSS-28 when heading 276 east of Songshan)', nav.autoTarget() === RCSS28);
place(RCSS10, 6000, 0, 0, 96);
check('autoTarget picks RCSS-10 when heading 096 west of Songshan', nav.autoTarget() === RCSS10);
nav.setTarget(RCSS10);
const first = nav.cycleTarget();
check('cycleTarget steps to the next-nearest end', first === RCSS28, first && first.key);
const second = nav.cycleTarget();
check('cycleTarget steps again (2nd nearest -> 3rd)', second && second !== RCSS28 && second.icao === 'RCTP', second && second.key);

// ---- 12. auto-retarget in free flight when lined up with another end ------------------
nav.setTarget(RCSS10); nav.setPhase('free');
place(RCSS28, 7000, 100, 0, 276); // lined up with runway 28
g = step(8, 0.5);
check('free: target switches to the runway end the aircraft is lined up with', nav.target === RCSS28, nav.target && nav.target.key);
check('... and the phase becomes landing', nav.phase === 'landing', nav.phase);

// ---- 13. robustness --------------------------------------------------------------------
nav.setTarget(null); g = step(1);
check('no target: instruction invites pressing L', /press L/.test(g.instruction) && g.target === null, g.instruction);
const savedAircraft = FS.aircraft; FS.aircraft = undefined; g = step(1);
check('FS.aircraft missing: guidance still valid with target null', g && g.target === null && typeof g.instruction === 'string');
FS.aircraft = savedAircraft;
const savedAirports = FS.airports; FS.airports = undefined; nav.setTarget(RCSS10); g = step(1);
check('FS.airports missing: update still runs and guidance is an object', g && typeof g.dist === 'number');
FS.airports = savedAirports;
nav.gatesEnabled = false; nav.setTarget(RCSS10); nav.setPhase('landing'); step(1);
check('gatesEnabled=false hides the approach group', scene.children.every((c) => !c.visible || c.name !== 'nav-approach-gates'));
nav.gatesEnabled = true; step(1);
check('gatesEnabled=true shows the approach group', scene.children.some((c) => c.visible && c.name === 'nav-approach-gates'));
check('scene holds only nav groups that are current (no leaks)', scene.children.filter((c) => c.name === 'nav-approach-gates').length === 1, String(scene.children.length));
check('no console warnings emitted by nav', warnings.length === 0, warnings.join(' | '));

// ---- summary ------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed' + (failed.length ? ' — FAILED: ' + failed.map((f) => f.name).join('; ') : ''));
process.exit(failed.length ? 1 : 0);
