/* ============================================================
   Taipei Skies — js/main.js
   Renderer, init sequence, game loop, camera modes, scenarios.
   Loaded LAST. Owns hotkeys: C, 1-4 (camera), P (pause), R (restart), Escape (menu).
   ============================================================ */
(function () {
  'use strict';
  const FS = window.FS;
  const V3 = THREE.Vector3;
  const UP = new V3(0, 1, 0);

  let renderer, scene, camera, clock, canvas;
  const camState = {
    pos: new V3(), look: new V3(), initialized: false,
    flyby: { pos: new V3(), placed: false },
    fov: 60,
  };

  const game = (FS.game = {
    running: false, paused: false, scenario: null, cameraMode: 'chase', time: 0, fps: 0,
    cameraModes: ['chase', 'cockpit', 'tower', 'flyby'],
    scenarios: [
      { id: 'takeoff-RCSS-10', title: 'Take off from Songshan', subtitle: 'RCSS runway 10 · downtown Taipei · wind calm', kind: 'takeoff', runway: 'RCSS-10' },
      { id: 'takeoff-RCSS-28', title: 'Take off from Songshan (west)', subtitle: 'RCSS runway 28 · climb out over the Tamsui River', kind: 'takeoff', runway: 'RCSS-28' },
      { id: 'takeoff-RCTP-05L', title: 'Take off from Taoyuan', subtitle: 'RCTP runway 05L · 30 km west of the city', kind: 'takeoff', runway: 'RCTP-05L' },
      { id: 'free-xinyi', title: 'Airborne over Taipei 101', subtitle: '2,500 ft over Xinyi at 100 kt · fly anywhere', kind: 'airborne', x: 3600, z: 4200, alt: 760, heading: 345, speed: 52 },
      { id: 'free-yangmingshan', title: 'Airborne over Yangmingshan', subtitle: '4,500 ft over the volcanoes, city to the south', kind: 'airborne', x: 1500, z: -9500, alt: 1370, heading: 175, speed: 55 },
      { id: 'final-RCSS-10', title: 'Final approach to Songshan', subtitle: 'ILS runway 10 · 6 nm out on the glideslope', kind: 'final', runway: 'RCSS-10', distance: 11000 },
      { id: 'final-RCTP-05L', title: 'Final approach to Taoyuan', subtitle: 'ILS runway 05L · 6 nm out', kind: 'final', runway: 'RCTP-05L', distance: 11000 },
    ],
    start(id) { startScenario(id); },
    restart() { if (game.scenario) startScenario(game.scenario.id); },
    setPaused(b) { game.paused = !!b; FS.events.emit('pause', game.paused); },
    setCameraMode(m) {
      if (game.cameraModes.indexOf(m) < 0) return;
      game.cameraMode = m; FS.settings.cameraMode = m;
      camState.initialized = false; camState.flyby.placed = false;
      FS.events.emit('cameraMode', m);
      if (FS.hud && FS.hud.showMessage) FS.hud.showMessage('Camera: ' + m, 1200);
    },
    cycleCamera() { const i = game.cameraModes.indexOf(game.cameraMode); game.setCameraMode(game.cameraModes[(i + 1) % game.cameraModes.length]); },
    openMenu() { game.running && game.setPaused(true); FS.input.enabled = false; FS.input.setMouseActive(false); if (FS.hud.showMenu) FS.hud.showMenu(); },
    closeMenu() { FS.input.enabled = true; if (FS.hud.hideMenu) FS.hud.hideMenu(); if (game.running) game.setPaused(false); },
  });

  // ---------------------------------------------------------------
  function startScenario(id) {
    const sc = game.scenarios.find((s) => s.id === id) || game.scenarios[0];
    game.scenario = sc;
    const ac = FS.aircraft, nav = FS.nav, ap = FS.airports;
    if (sc.kind === 'takeoff') {
      const end = ap.getRunwayEnd(sc.runway);
      ac.reset({ x: end.spawn.x, z: end.spawn.z, heading: end.spawn.heading, onGround: true, speed: 0, throttle: 0, flaps: 0 });
      nav.setTarget(end); nav.setPhase('takeoff');
    } else if (sc.kind === 'final') {
      const end = ap.getRunwayEnd(sc.runway);
      const d = sc.distance || 11000;
      const x = end.threshold.x - end.dir.x * d, z = end.threshold.z - end.dir.z * d;
      const alt = end.elev + 15 + d * Math.tan(3 * FS.geo.D2R); // 3 deg glideslope + threshold crossing height
      ac.reset({ x, z, altitude: alt, heading: end.heading, onGround: false, speed: 36, throttle: 0.45, flaps: 0.5 });
      nav.setTarget(end); nav.setPhase('landing');
    } else {
      ac.reset({ x: sc.x, z: sc.z, altitude: sc.alt, heading: sc.heading, onGround: false, speed: sc.speed, throttle: 0.7, flaps: 0 });
      nav.setTarget(nav.autoTarget ? nav.autoTarget() : null); nav.setPhase('free');
    }
    game.running = true; game.paused = false; game.time = 0;
    camState.initialized = false; camState.flyby.placed = false;
    FS.input.enabled = true;
    if (FS.hud.hideMenu) FS.hud.hideMenu();
    try { canvas.focus(); } catch (e) { /* ignore */ }
    FS.events.emit('scenarioStart', sc);
  }

  // ---------------------------------------------------------------
  const tmpQ = new THREE.Quaternion(), tmpV = new V3(), tmpV2 = new V3(), tmpV3 = new V3();
  function updateCamera(dt) {
    const ac = FS.aircraft, s = ac.state, g = ac.group;
    let fov = 60;
    const mode = game.cameraMode;
    if (mode === 'cockpit') {
      const eye = ac.eyePoint || new V3(0, 1.0, -0.4);
      tmpV.copy(eye); g.localToWorld(tmpV);
      camera.position.copy(tmpV);
      camera.quaternion.copy(g.quaternion);
      camera.up.set(0, 1, 0);
      fov = 68;
    } else if (mode === 'tower' && towerFor(s)) {
      const t = towerFor(s);
      camera.position.set(t.x, t.y, t.z);
      camera.up.set(0, 1, 0);
      camera.lookAt(s.pos);
      const dist = camera.position.distanceTo(s.pos);
      fov = FS.geo.clamp(60 * Math.pow(250 / Math.max(dist, 250), 0.7), 7, 60);
    } else if (mode === 'flyby') {
      const fb = camState.flyby;
      const vel = tmpV.copy(s.vel); if (vel.lengthSq() < 1) vel.copy(s.forward || new V3(0, 0, -1));
      const dir = vel.normalize();
      const ahead = tmpV2.copy(s.pos).sub(fb.pos).dot(dir);
      if (!fb.placed || ahead > 350 || fb.pos.distanceTo(s.pos) > 1400) {
        const side = tmpV3.crossVectors(dir, UP).normalize().multiplyScalar((Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 90));
        fb.pos.copy(s.pos).addScaledVector(dir, 450 + Math.random() * 250).add(side);
        fb.pos.y += -20 + Math.random() * 80;
        const ground = FS.world.getHeight(fb.pos.x, fb.pos.z);
        const obst = FS.city.getObstacleTop ? FS.city.getObstacleTop(fb.pos.x, fb.pos.z) : -Infinity;
        fb.pos.y = Math.max(fb.pos.y, ground + 6, (isFinite(obst) ? obst : -1e9) + 6);
        fb.placed = true;
      }
      camera.position.copy(fb.pos);
      camera.up.set(0, 1, 0);
      camera.lookAt(s.pos);
      const dist = camera.position.distanceTo(s.pos);
      fov = FS.geo.clamp(60 * Math.pow(120 / Math.max(dist, 120), 0.6), 14, 60);
    } else {
      // chase: behind and above, follows heading (and a fraction of bank), smoothed
      const off = ac.chaseOffset || new V3(0, 4.5, 17);
      tmpQ.setFromAxisAngle(UP, FS.geo.headingToYaw(s.heading));
      tmpV.copy(off).applyQuaternion(tmpQ);
      // when nose is pitched, lift the camera a bit so the aircraft stays framed
      tmpV.y += FS.geo.clamp(-s.pitch, -25, 25) * 0.05;
      const desired = tmpV2.copy(s.pos).add(tmpV);
      const ground = FS.world.getHeight(desired.x, desired.z);
      if (desired.y < ground + 2.5) desired.y = ground + 2.5;
      if (!camState.initialized) { camState.pos.copy(desired); camState.initialized = true; }
      const k = 1 - Math.exp(-dt * 6);
      camState.pos.lerp(desired, k);
      camera.position.copy(camState.pos);
      // slight roll follow gives a feel of banking without losing the horizon
      const acUp = tmpV3.set(0, 1, 0).applyQuaternion(g.quaternion);
      camera.up.copy(UP).lerp(acUp, 0.22).normalize();
      const fwd = tmpV.copy(s.forward || new V3(0, 0, -1));
      camera.lookAt(tmpV2.copy(s.pos).addScaledVector(fwd, 12).addScaledVector(UP, 1.0));
    }
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  function towerFor(s) {
    const ap = FS.airports;
    if (!ap || !ap.nearest) return null;
    const a = ap.nearest(s.pos.x, s.pos.z);
    if (!a || !a.tower) return null;
    const d = FS.geo.dist(a.tower.x, a.tower.z, s.pos.x, s.pos.z);
    return d < 9000 ? a.tower : null;
  }

  // ---------------------------------------------------------------
  function handleHotkeys() {
    const inp = FS.input;
    if (inp.wasPressed('Escape')) {
      if (FS.hud.isMenuOpen && FS.hud.isMenuOpen()) game.closeMenu(); else if (game.running) game.openMenu();
    }
    if (!inp.enabled) return;
    if (inp.wasPressed('KeyC')) game.cycleCamera();
    if (inp.wasPressed('Digit1')) game.setCameraMode('chase');
    if (inp.wasPressed('Digit2')) game.setCameraMode('cockpit');
    if (inp.wasPressed('Digit3')) game.setCameraMode('tower');
    if (inp.wasPressed('Digit4')) game.setCameraMode('flyby');
    if (inp.wasPressed('KeyP') && game.running) game.setPaused(!game.paused);
    if (inp.wasPressed('KeyR') && game.running) game.restart();
  }

  // ---------------------------------------------------------------
  let fpsAcc = 0, fpsN = 0;
  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { game.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    handleHotkeys();
    const sim = game.running && !game.paused;
    if (sim) {
      game.time += dt;
      FS.aircraft.update(dt);
      FS.nav.update(dt);
    }
    const st = FS.aircraft.state;
    if (FS.airports.update) FS.airports.update(dt, st);
    FS.world.update(dt, camera, st.pos);
    if (FS.city.update) FS.city.update(dt, camera.position);
    updateCamera(dt);
    if (FS.world.setShadowFocus) FS.world.setShadowFocus(st.pos, camera.position);
    FS.hud.update(dt);
    renderer.render(scene, camera);
    FS.input.endFrame();
  }

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    FS.events.emit('resize', { w, h });
  }

  // ---------------------------------------------------------------
  const loadingEl = () => document.getElementById('loading');
  function setStatus(text, frac) {
    const s = document.getElementById('loading-status'); if (s) s.textContent = text;
    const b = document.getElementById('loading-bar'); if (b && frac != null) b.style.width = Math.round(frac * 100) + '%';
  }
  function showError(msg) {
    const e = document.getElementById('errbox');
    if (e) { e.hidden = false; e.textContent += (e.textContent ? '\n' : '') + msg; }
    console.error(msg);
  }
  // setTimeout rather than requestAnimationFrame so loading also completes in a background tab
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));
  async function step(label, frac, fn) {
    setStatus(label, frac); await nextFrame();
    const t0 = performance.now();
    fn();
    console.log('[init] ' + label + ' — ' + Math.round(performance.now() - t0) + ' ms');
  }

  async function boot() {
    FS.settings.load();
    canvas = document.getElementById('gl');
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    } catch (e) {
      setStatus('WebGL is not available in this browser.'); showError(String(e)); return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, FS.settings.quality === 'high' ? 2 : 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = !!FS.settings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, 150000);
    camera.position.set(0, 800, 3000);
    clock = new THREE.Clock();
    FS.renderer = renderer; FS.scene = scene; FS.camera = camera;
    FS.input.bind(canvas);
    window.addEventListener('resize', onResize);

    game.cameraMode = game.cameraModes.indexOf(FS.settings.cameraMode) >= 0 ? FS.settings.cameraMode : 'chase';

    try {
      await step('Shaping the Taipei basin, rivers and mountains', 0.05, () => FS.world.init(scene, renderer));
      await step('Laying out streets and raising the city', 0.35, () => FS.city.init(scene));
      await step('Paving Songshan and Taoyuan', 0.65, () => FS.airports.init(scene));
      await step('Rolling out the aircraft', 0.8, () => FS.aircraft.init(scene));
      await step('Tuning the ILS and approach gates', 0.88, () => FS.nav.init(scene));
      await step('Lighting up the HUD', 0.95, () => FS.hud.init());
    } catch (e) {
      setStatus('Something failed while building the world.'); showError((e && e.stack) || String(e)); return;
    }
    setStatus('Ready', 1);
    await nextFrame();
    const l = loadingEl(); if (l) l.hidden = true;
    // Park the aircraft on Songshan runway 10 so the menu has a live scene behind it
    const end = FS.airports.getRunwayEnd('RCSS-10');
    FS.aircraft.reset({ x: end.spawn.x, z: end.spawn.z, heading: end.spawn.heading, onGround: true, speed: 0, throttle: 0, flaps: 0 });
    FS.nav.setTarget(end); FS.nav.setPhase('takeoff');
    FS.input.enabled = false;
    if (FS.hud.showStartMenu) FS.hud.showStartMenu();
    frame();
  }

  window.addEventListener('error', (e) => { if (!game.running) showError(e.message || String(e.error || e)); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
