/* ============================================================
   Taipei Skies — js/hud.js
   Head-up display drawn on a 2D canvas over the 3D view, DOM
   overlays (start menu, in-game menu, settings, help, crash,
   landing report, toasts, paused), the minimap panel and the
   procedural WebAudio sound (engine, wind, stall horn, touchdown,
   gate chime, crash).
   Exports FS.hud = { init, update, showStartMenu, showMenu, hideMenu,
     isMenuOpen, showMessage, showLandingReport, showCrash, minimapCanvas }
   Additions to the contract: showMessage(text, ms, { big }) takes an
   optional third argument; FS.hud.cycleMinimap(), toggleSound(),
   toggleHud() and FS.hud.audio are exposed for convenience.
   Hotkeys owned: M (minimap range), H (help), K (sound), T (HUD).
   ============================================================ */
(function () {
  'use strict';
  const FS = (window.FS = window.FS || {});

  // ---------------------------------------------------------------
  // Constants and small helpers
  // ---------------------------------------------------------------
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MS_TO_KT = 1.943844, M_TO_FT = 3.28084, MS_TO_FPM = 196.8504, M_TO_NM = 1 / 1852;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrap360 = (h) => { h %= 360; if (h < 0) h += 360; return h; };
  const wrap180 = (h) => ((((h + 180) % 360) + 360) % 360) - 180;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const isVec = (v) => !!v && typeof v.x === 'number' && typeof v.z === 'number';
  const fmtInt = (n) => { n = Math.round(num(n, 0)); return (n < 0 ? '-' : '') + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  const pad3 = (h) => String(Math.round(wrap360(num(h, 0))) % 360).padStart(3, '0');
  const tgtLabel = (t) => (t ? (((t.icao || '') + ' ' + (t.id || '')).trim() || t.key || 'RWY') : '');

  const COL = {
    green: '#8ff7a5', amber: '#ffcc4d', red: '#ff5a5a', magenta: '#ff6ad5', cyan: '#4fe3ff', white: '#f2f6fa',
    dim: 'rgba(200,232,214,.72)', outline: 'rgba(0,20,10,.75)', box: 'rgba(4,14,20,.5)',
  };
  const FONT_HEAD = "'Barlow Condensed','Arial Narrow',sans-serif";
  const FONT_MONO = "'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const MAP_RANGES = [0, 6000, 20000, 60000];
  const PHASE_LABEL = { takeoff: 'TAKEOFF', free: 'FREE FLIGHT', landing: 'APPROACH' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setText(e, t) { if (e && e.textContent !== t) e.textContent = t; }
  let errCount = 0;
  function warnOnce(e) { if (errCount++ < 3) console.warn('[hud]', e); }

  // ---------------------------------------------------------------
  // CSS (injected once by init)
  // ---------------------------------------------------------------
  const CSS = `
#hud-root { --hud-green:#8ff7a5; --hud-amber:#ffcc4d; --hud-red:#ff5a5a; --hud-magenta:#ff6ad5; --hud-cyan:#4fe3ff;
  --hud-glass:rgba(8,18,28,.82); --hud-border:#2a4256; --hud-text:#f2f6fa; --hud-dim:#9fb4c6;
  --hud-font-head:'Barlow Condensed','Arial Narrow',sans-serif; --hud-font-mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  position:absolute; inset:0; pointer-events:none; z-index:10; overflow:hidden; font-family:var(--hud-font-mono); font-size:13px; color:var(--hud-text); }
#hud-root, #hud-root * { box-sizing:border-box; }
#hud-root [hidden] { display:none !important; }
#hud-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none; }
.hud-panel { pointer-events:auto; background:var(--hud-glass); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border:1px solid var(--hud-border); border-radius:10px; color:#fff; }
.hud-btn { pointer-events:auto; font-family:var(--hud-font-head); font-weight:600; font-size:15px; letter-spacing:.08em; text-transform:uppercase; color:#e8f1f8;
  background:rgba(20,38,54,.9); border:1px solid #3a5a74; border-radius:6px; padding:7px 14px; cursor:pointer; transition:background .12s, border-color .12s; }
.hud-btn:hover { background:#24455f; border-color:#5fa3cf; }
.hud-btn:active { transform:translateY(1px); }
.hud-btn:focus-visible { outline:2px solid var(--hud-cyan); outline-offset:2px; }
.hud-btn.primary { background:#1d6f8c; border-color:#4fc3ea; color:#fff; }
.hud-btn.primary:hover { background:#2489ab; }
.hud-btn.small { font-size:12px; padding:4px 10px; }
.hud-btn.danger { border-color:#7a3a3a; }
.hud-btn.danger:hover { background:#4a1c22; }
.hud-btn.wide { display:block; width:100%; text-align:left; }
.hud-kbd { display:inline-block; font-family:var(--hud-font-mono); font-size:11px; padding:1px 6px; border:1px solid #3a5a74; border-bottom-width:2px; border-radius:4px; background:#10202e; color:#cfe3f2; white-space:nowrap; }
.hud-chip { font-family:var(--hud-font-mono); font-size:12px; padding:4px 8px; border-radius:6px; background:rgba(8,18,28,.7); border:1px solid var(--hud-border); color:var(--hud-text); font-variant-numeric:tabular-nums; }
.hud-chip.head { font-family:var(--hud-font-head); font-weight:600; font-size:13px; text-transform:uppercase; letter-spacing:.1em; }
.hud-title { font-family:var(--hud-font-head); font-weight:700; text-transform:uppercase; letter-spacing:.16em; }
.hud-h { font-family:var(--hud-font-head); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.14em; color:var(--hud-dim); margin:0 0 8px; }
#hud-chips { position:absolute; top:12px; left:12px; display:flex; flex-wrap:wrap; gap:6px; max-width:46%; pointer-events:none; }
#hud-chips .hud-chip { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
#hud-chips .phase { color:var(--hud-cyan); }
#hud-chips .phase.landed { color:var(--hud-green); }
#hud-chips .phase.crashed { color:var(--hud-red); }
#hud-buttons { position:absolute; top:12px; right:12px; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; max-width:50%; pointer-events:none; }
#hud-buttons .hud-btn { white-space:nowrap; }
#hud-minimap { position:absolute; right:12px; bottom:12px; padding:6px; display:flex; flex-direction:column; gap:4px; cursor:pointer; }
#hud-minimap canvas { display:block; width:240px; height:240px; border-radius:6px; background:#0b1a26; }
#hud-minimap .bar { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:0 2px; font-family:var(--hud-font-head); font-weight:600; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--hud-dim); }
#hud-minimap .bar b { color:var(--hud-cyan); font-weight:600; }
#hud-toasts { position:absolute; left:12px; bottom:56px; display:flex; flex-direction:column; align-items:flex-start; gap:6px; pointer-events:none; }
#hud-toasts .hud-chip { animation:hud-in .15s ease-out; transition:opacity .4s; }
#hud-bigtoasts { position:absolute; top:22%; left:0; right:0; text-align:center; pointer-events:none; }
#hud-bigtoasts .big { display:inline-block; font-family:var(--hud-font-head); font-weight:700; font-size:34px; letter-spacing:.14em; text-transform:uppercase; padding:10px 26px; border-radius:10px;
  background:var(--hud-glass); border:1px solid rgba(255,106,213,.6); color:#fff; animation:hud-in .15s ease-out; transition:opacity .4s; }
.hud-fade { opacity:0; }
@keyframes hud-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
#hud-paused { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none; }
#hud-paused .box { text-align:center; padding:18px 40px; }
#hud-paused .t { font-family:var(--hud-font-head); font-weight:700; font-size:44px; letter-spacing:.22em; text-transform:uppercase; }
#hud-paused .s { color:var(--hud-dim); font-size:12px; margin-top:6px; }
.hud-float { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:16px; pointer-events:none; }
.hud-float > .hud-panel { width:min(460px,100%); max-height:calc(100% - 32px); overflow:auto; padding:20px 24px; }
.hud-modal { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(3,8,14,.45); pointer-events:auto; overflow:hidden; }
.hud-modal > .hud-panel { max-height:calc(100% - 32px); overflow:auto; padding:22px 26px; }
.hud-start { width:min(1080px,100%); display:grid; grid-template-columns:1.1fr 1fr; gap:22px; }
.hud-menu { width:min(720px,100%); }
.hud-help { width:min(820px,100%); }
@media (max-width:899px) { .hud-start { grid-template-columns:1fr; } }
@media (max-width:700px), (max-height:520px) { #hud-minimap canvas { width:150px; height:150px; } #hud-chips { max-width:60%; } #hud-buttons .hud-btn { font-size:11px; padding:3px 7px; } .hud-modal > .hud-panel { padding:16px; } }
.hud-start .big-title { font-size:44px; line-height:1; color:#fff; }
.hud-start .under { color:var(--hud-dim); font-size:12px; letter-spacing:.08em; text-transform:uppercase; margin-top:6px; }
.hud-start .tag { color:#e8eef4; margin:10px 0 16px; font-size:13px; }
.hud-cards { display:flex; flex-direction:column; gap:8px; }
.hud-card { pointer-events:auto; display:block; width:100%; text-align:left; background:rgba(20,38,54,.7); border:1px solid #3a5a74; border-radius:8px; padding:10px 12px; color:#fff; cursor:pointer; font-family:var(--hud-font-mono); transition:background .12s, border-color .12s; }
.hud-card:hover { background:#24455f; border-color:#5fa3cf; }
.hud-card:focus-visible { outline:2px solid var(--hud-cyan); outline-offset:2px; }
.hud-card .kind { display:inline-block; font-family:var(--hud-font-head); font-weight:600; font-size:11px; letter-spacing:.14em; text-transform:uppercase; margin-bottom:3px; }
.hud-card .kind.takeoff { color:var(--hud-green); } .hud-card .kind.airborne { color:var(--hud-cyan); } .hud-card .kind.final { color:var(--hud-magenta); }
.hud-card .ttl { font-family:var(--hud-font-head); font-weight:600; font-size:20px; line-height:1.1; }
.hud-card .sub { color:var(--hud-dim); font-size:12px; margin-top:2px; }
.hud-section { margin-top:18px; }
.hud-cheat { display:grid; grid-template-columns:auto 1fr; column-gap:12px; row-gap:5px; font-size:12px; align-items:baseline; }
.hud-cheat .k { white-space:nowrap; } .hud-cheat .a { color:#e8eef4; }
.hud-field { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:5px 0; border-bottom:1px solid rgba(42,66,86,.6); font-size:12px; }
.hud-field label { color:#e8eef4; }
.hud-field .ctl { display:flex; align-items:center; gap:8px; pointer-events:auto; }
.hud-field input[type=range] { width:120px; accent-color:var(--hud-cyan); }
.hud-field input[type=checkbox] { width:16px; height:16px; accent-color:var(--hud-cyan); cursor:pointer; }
.hud-field select { background:#10202e; border:1px solid #3a5a74; border-radius:6px; color:#e8eef4; font-family:var(--hud-font-mono); font-size:12px; padding:3px 6px; }
.hud-field .val { min-width:2.6em; text-align:right; font-variant-numeric:tabular-nums; color:var(--hud-cyan); }
.hud-note { color:var(--hud-dim); font-size:11px; margin-top:8px; }
.hud-menu .stack { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
.hud-menu .sub-title { color:var(--hud-dim); font-size:12px; margin-top:4px; }
.hud-primer { margin:0; padding-left:20px; font-size:12px; line-height:1.55; color:#e8eef4; }
.hud-primer li { margin:2px 0; }
.hud-row { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
.hud-crash .t { color:var(--hud-red); font-size:34px; }
.hud-crash .r { margin:8px 0 4px; font-size:14px; }
.hud-crash .s, .hud-report .s { color:var(--hud-dim); font-size:12px; }
.hud-report .head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.hud-report .t { font-size:26px; }
.hud-report .grade { font-family:var(--hud-font-head); font-weight:700; font-size:44px; width:64px; height:64px; border-radius:12px; display:flex; align-items:center; justify-content:center; border:2px solid currentColor; }
.hud-report .grade.A { color:var(--hud-green); } .hud-report .grade.B { color:var(--hud-cyan); } .hud-report .grade.C { color:var(--hud-amber); } .hud-report .grade.D { color:var(--hud-red); }
.hud-report table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
.hud-report td { padding:5px 0; border-bottom:1px solid rgba(42,66,86,.6); }
.hud-report td.l { color:var(--hud-dim); } .hud-report td.v { text-align:right; font-variant-numeric:tabular-nums; }
.hud-report td .hint { color:var(--hud-dim); font-size:11px; margin-left:6px; }
.hud-report .c { margin-top:12px; font-size:13px; color:#e8eef4; }
.v-good { color:var(--hud-green); } .v-warn { color:var(--hud-amber); } .v-bad { color:var(--hud-red); }
`;

  // ---------------------------------------------------------------
  // Procedural audio (WebAudio, created lazily on the first gesture)
  //   unlock()                        create + resume the AudioContext (call on every user gesture; cheap once running)
  //   setEnabled(bool)                master gate, ramps 0.4 <-> 0 over ~0.15 s; mirrored in api.enabled
  //   update(dt, snap)                per-frame drive of engine, exhaust, wind, gear rumble and stall horn
  //   touchdown(vsAbs, groundSpeed)   one-shot thump + tire chirp
  //   gateChime() / crash() / click() one-shots
  // Nothing sounds until unlock() has run. Without Web Audio every method is a silent no-op.
  // ---------------------------------------------------------------
  function createAudio() {
    const noop = () => {};
    const tnow = () => (window.performance && typeof performance.now === 'function' ? performance.now() : Date.now());
    const link = (...nodes) => { for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]); };

    let ctx = null;     // AudioContext, created lazily by unlock()
    let g = null;       // continuous graph, built once together with the context
    let failed = false; // Web Audio missing or construction threw: stay silent forever
    const st = { hornTimer: 0, hornOn: false, jit: 0, resumeAt: -1e9, last: {} };

    const api = {
      enabled: true,
      get ready() { return !!ctx && ctx.state === 'running'; },
      unlock, setEnabled, update, touchdown, gateChime, crash, click,
    };

    function unlock() {
      if (failed) return;
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { fail(); return; }
        try { ctx = new AC(); g = build(ctx); } catch (e) { fail(); return; }
      }
      if (ctx.state !== 'running') {
        st.resumeAt = tnow();
        try {
          const p = typeof ctx.resume === 'function' ? ctx.resume() : null;
          if (p && typeof p.catch === 'function') p.catch(noop);
        } catch (e) { /* stays suspended until the next gesture */ }
      }
    }
    function fail() {
      failed = true; g = null;
      if (ctx) {
        try { const p = ctx.close(); if (p && typeof p.catch === 'function') p.catch(noop); } catch (e) { /* ignore */ }
        ctx = null;
      }
      console.warn('[hud-audio] Web Audio is unavailable; the HUD stays silent.');
    }
    function setEnabled(on) {
      api.enabled = !!on;
      if (!g) return;
      try { g.master.gain.setTargetAtTime(api.enabled ? 0.4 : 0, ctx.currentTime, 0.05); } catch (e) { /* ignore */ }
    }
    // One-shots may also fire while a resume() requested within the last second is still pending
    // (Safari resolves it asynchronously, so the very click that unlocks audio can still tick).
    function canFire() {
      if (!g || !api.enabled) return false;
      if (ctx.state === 'running') return true;
      return ctx.state === 'suspended' && tnow() - st.resumeAt < 1000;
    }

    function makeNoise(ac, brownish) {
      const sr = ac.sampleRate, n = Math.floor(sr * 2);
      const buf = ac.createBuffer(1, n, sr);
      const d = new Float32Array(n);
      if (!brownish) {
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      } else {
        // leaky integration of white noise; drift and DC removed so the 2 s loop is seamless, then normalised
        let last = 0;
        for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last; }
        const drift = d[n - 1] - d[0];
        let mean = 0;
        for (let i = 0; i < n; i++) { d[i] -= drift * (i / (n - 1)); mean += d[i]; }
        mean /= n;
        let peak = 1e-6;
        for (let i = 0; i < n; i++) { d[i] -= mean; const a = Math.abs(d[i]); if (a > peak) peak = a; }
        for (let i = 0; i < n; i++) d[i] /= peak;
      }
      if (typeof buf.copyToChannel === 'function') buf.copyToChannel(d, 0); else buf.getChannelData(0).set(d);
      return buf;
    }
    function build(ac) {
      const gain = (v) => { const n = ac.createGain(); n.gain.value = v; return n; };
      const lowpass = (f, q) => { const n = ac.createBiquadFilter(); n.type = 'lowpass'; n.frequency.value = f; n.Q.value = q; return n; };
      const osc = (type, f) => { const n = ac.createOscillator(); n.type = type; n.frequency.value = f; return n; };
      const loop = (buf, offset) => { const n = ac.createBufferSource(); n.buffer = buf; n.loop = true; n.start(0, offset); return n; };
      const white = makeNoise(ac, false), brown = makeNoise(ac, true);

      const master = gain(api.enabled ? 0.4 : 0);
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
      link(master, comp, ac.destination);

      // engine: two-blade prop firing rate (rpm / 60 * 2); saw + square an octave below, +3 cents so they beat
      const saw = osc('sawtooth', 23.3), sq = osc('square', 11.7);
      sq.detune.value = 3;
      const engFilter = lowpass(180, 0.8), engGain = gain(0);
      link(saw, gain(0.55), engFilter);
      link(sq, gain(0.45), engFilter);
      link(engFilter, engGain, master);
      saw.start(); sq.start();

      const exFilter = lowpass(250, 1), exGain = gain(0);
      link(loop(brown, 0), exFilter, exGain, master);

      const windFilter = lowpass(300, 0.7), windGain = gain(0);
      link(loop(white, 0), windFilter, windGain, master);

      // gear rumble shares the brown buffer but starts 1 s into it so it doesn't correlate with the exhaust
      const gearGain = gain(0);
      link(loop(brown, 1), lowpass(110, 1), gearGain, master);

      const horn = osc('square', 800), hornGain = gain(0);
      link(horn, lowpass(2000, 1), hornGain, master);
      horn.start();

      return { white, brown, master, saw, sq, engFilter, engGain, exFilter, exGain, windFilter, windGain, gearGain, hornGain };
    }

    function target(param, key, value, tc) {
      const prev = st.last[key];
      if (prev !== undefined && Math.abs(value - prev) <= 1e-4 + Math.abs(value) * 1e-3) return;
      st.last[key] = value;
      param.setTargetAtTime(value, ctx.currentTime, tc);
    }
    function hornPulse(on) {
      if (on === st.hornOn) return;
      st.hornOn = on;
      g.hornGain.gain.setTargetAtTime(on ? 0.12 : 0, ctx.currentTime, 0.01);
    }
    function update(dt, snap) {
      if (!g) return;
      try {
        dt = clamp(num(dt, 1 / 60), 0, 0.05);
        snap = snap || {};
        const throttle = clamp(num(snap.throttle, 0), 0, 1);
        const rpm = Math.max(0, num(snap.rpm, 700 + throttle * 1900));
        const airspeed = Math.max(0, num(snap.airspeed, 0));
        const groundSpeed = Math.max(0, num(snap.groundSpeed, airspeed));
        const flaps = clamp(num(snap.flaps, 0), 0, 1);
        const onGround = !!snap.onGround;
        const live = snap.running !== false && !snap.paused && !snap.crashed;
        const cam = snap.cameraMode;
        const far = cam === 'tower' || cam === 'flyby';
        const cockpit = cam === 'cockpit';

        // engine + exhaust; jit is a bounded random walk (+-0.3 %) so the drone hunts a little
        st.jit = clamp(st.jit * 0.94 + (Math.random() - 0.5) * 0.0024, -0.003, 0.003);
        const f = Math.max(5, (rpm / 60) * 2) * (1 + st.jit);
        const engineOn = live && rpm > 50;
        const distance = far ? 0.6 : 1;
        target(g.saw.frequency, 'sawF', f, 0.06);
        target(g.sq.frequency, 'sqF', f / 2, 0.06);
        target(g.engFilter.frequency, 'engLp', 180 + throttle * 1900, 0.1);
        target(g.engGain.gain, 'eng', engineOn ? (0.04 + throttle * 0.22) * distance : 0, 0.1);
        target(g.exFilter.frequency, 'exLp', 250 + throttle * 700, 0.1);
        target(g.exGain.gain, 'ex', engineOn ? (0.02 + throttle * 0.08) * (cockpit ? 1.25 : distance) : 0, 0.1);

        // wind + flap buffet
        let wind = Math.pow(clamp((airspeed - 8) / 55, 0, 1), 1.6) * 0.28;
        if (!onGround) wind += flaps * 0.04;
        wind *= cockpit ? 1.5 : far ? 0.5 : 1;
        target(g.windFilter.frequency, 'windLp', Math.min(300 + airspeed * 35, 12000), 0.12);
        target(g.windGain.gain, 'wind', live ? wind : 0, 0.1);

        target(g.gearGain.gain, 'gear', live && onGround ? clamp(groundSpeed / 35, 0, 1) * 0.14 : 0, 0.1);

        // stall horn: ~3.5 Hz pulses, 100 ms on, timed from dt
        if (live && snap.stall && !onGround) {
          st.hornTimer = (st.hornTimer + dt) % (1 / 3.5);
          hornPulse(st.hornTimer < 0.1);
        } else {
          st.hornTimer = 0;
          hornPulse(false);
        }
      } catch (e) { /* audio must never break the frame */ }
    }

    // attack (s) to peak, then exponential decay (s) to silence; returns the end time
    function env(node, t0, attack, peak, decay) {
      const p = node.gain;
      p.setValueAtTime(0.0001, t0);
      p.linearRampToValueAtTime(Math.max(peak, 0.0005), t0 + attack);
      p.exponentialRampToValueAtTime(0.0004, t0 + attack + decay);
      return t0 + attack + decay;
    }
    function release(src, tail) {
      src.onended = function () { try { tail.disconnect(); } catch (e) { /* already gone */ } };
    }
    function touchdown(vsAbs, groundSpeed) {
      if (!canFire()) return;
      try {
        const t0 = ctx.currentTime + 0.01;
        const hard = clamp(num(vsAbs, 1) / 4, 0.15, 1);
        const spd = clamp(num(groundSpeed, 30) / 40, 0.2, 1);
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(90, t0);
        o.frequency.exponentialRampToValueAtTime(45, t0 + 0.25);
        const tEnd = env(og, t0, 0.006, hard * 0.6, 0.3);
        link(o, og, g.master);
        o.start(t0); o.stop(tEnd + 0.02);
        release(o, og);
        const dur = 0.08 + 0.04 * spd;
        const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), sg = ctx.createGain();
        s.buffer = g.white;
        bp.type = 'bandpass'; bp.frequency.value = 1500 + 500 * spd; bp.Q.value = 2.5;
        env(sg, t0, 0.008, spd * 0.3, dur - 0.008);
        link(s, bp, sg, g.master);
        s.start(t0, Math.random() * 1.5, dur + 0.02);
        release(s, sg);
      } catch (e) { /* never throw */ }
    }
    function bell(freq, t0) {
      const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), ng = ctx.createGain(), hg = ctx.createGain();
      o1.type = 'sine'; o1.frequency.value = freq;
      o2.type = 'sine'; o2.frequency.value = freq * 2;
      hg.gain.setValueAtTime(0.3, t0);
      hg.gain.exponentialRampToValueAtTime(0.02, t0 + 0.4); // the 2nd harmonic dies faster, like a real bell
      const tEnd = env(ng, t0, 0.04, 0.15, 0.7);
      link(o1, ng, g.master);
      link(o2, hg, ng);
      o1.start(t0); o2.start(t0);
      o1.stop(tEnd + 0.02); o2.stop(tEnd + 0.02);
      release(o1, ng);
    }
    function gateChime() {
      if (!canFire()) return;
      try {
        const t0 = ctx.currentTime + 0.01;
        bell(880, t0);            // A5
        bell(1174.66, t0 + 0.12); // D6
      } catch (e) { /* never throw */ }
    }
    function crash() {
      if (!canFire()) return;
      try {
        const t0 = ctx.currentTime + 0.01;
        const lp = ctx.createBiquadFilter(), ng = ctx.createGain();
        lp.type = 'lowpass'; lp.Q.value = 1.2;
        lp.frequency.setValueAtTime(3000, t0);
        lp.frequency.exponentialRampToValueAtTime(150, t0 + 1.2);
        const tEnd = env(ng, t0, 0.015, 0.55, 1.185);
        link(lp, ng, g.master);
        const w = ctx.createBufferSource(), b = ctx.createBufferSource();
        w.buffer = g.white; b.buffer = g.brown;
        w.connect(lp); b.connect(lp);
        const len = tEnd - t0 + 0.05;
        w.start(t0, Math.random() * 0.6, len);
        b.start(t0, Math.random() * 0.6, len);
        release(w, ng);
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(60, t0);
        o.frequency.exponentialRampToValueAtTime(38, t0 + 0.5);
        const t2 = env(og, t0, 0.01, 0.8, 0.6);
        link(o, og, g.master);
        o.start(t0); o.stop(t2 + 0.02);
        release(o, og);
      } catch (e) { /* never throw */ }
    }
    function click() {
      if (!canFire()) return;
      try {
        const t0 = ctx.currentTime + 0.005;
        const o = ctx.createOscillator(), og = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 1200;
        const tEnd = env(og, t0, 0.002, 0.05, 0.018);
        link(o, og, g.master);
        o.start(t0); o.stop(tEnd + 0.01);
        release(o, og);
      } catch (e) { /* never throw */ }
    }

    return api;
  }

  // ---------------------------------------------------------------
  // DOM overlays: start menu, in-game menu, settings, help, crash,
  // landing report, toasts, paused. All buttons blur() after click.
  // ---------------------------------------------------------------
  const CHEAT = [
    ['Mouse', 'click the view to fly with the mouse (pull = nose up) · Esc or right-click releases'],
    ['W / S · ↑ ↓', 'pitch down / up'],
    ['A / D · ← →', 'roll'],
    ['Q / E', 'rudder'],
    ['Shift / Ctrl · wheel · PgUp / PgDn', 'throttle'],
    ['F', 'flaps'],
    ['B · Space', 'brakes toggle · brakes while held'],
    ['C · 1–4', 'camera: chase, cockpit, tower, flyby'],
    ['L', 'cycle target runway (nearest first)'],
    ['N', 'guidance gates on / off'],
    ['M', 'map range: off · 6 km · 20 km · 60 km'],
    ['H', 'help'],
    ['P', 'pause'],
    ['R', 'restart scenario'],
    ['T', 'HUD on / off'],
    ['K', 'sound on / off'],
    ['Esc', 'menu · releases the mouse'],
  ];
  const FIELDS = [
    { key: 'mouseSensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.3, max: 2.5, step: 0.1 },
    { key: 'invertMouseY', label: 'Invert mouse Y', type: 'check' },
    { key: 'invertKeyPitch', label: 'Invert W / S', type: 'check' },
    { key: 'quality', label: 'Quality', type: 'select', options: ['low', 'medium', 'high'], note: 'after reload' },
    { key: 'shadows', label: 'Shadows', type: 'check' },
    { key: 'sound', label: 'Sound', type: 'check' },
    { key: 'cameraMode', label: 'Camera', type: 'select', options: ['chase', 'cockpit', 'tower', 'flyby'] },
    { key: 'guidance', label: 'Guidance', type: 'check' },
    { key: 'showFps', label: 'Show FPS', type: 'check' },
  ];
  const COMMENTS = {
    A: ['Greased it — Songshan tower is impressed.', 'Butter. The passengers did not even look up.', 'Textbook: on speed, on centerline, in the zone.'],
    B: ['Firm but fair; the passengers are clapping.', 'Solid arrival. A touch more flare next time.', 'Good landing — the airplane is reusable.'],
    C: ['You walked away from it. Maintenance wants a word.', 'That one rattled the overhead bins.', 'Down and stopped, but the tires filed a complaint.'],
    D: ['That was an arrival, not a landing.', 'The runway is still there; check the gear.', 'Tower asks whether you need assistance.'],
  };

  function createMenus(opts) {
    const root = opts.root;
    const game = () => FS.game || {};
    let reportTimer = 0, helpReturn = null, lastReport = null;
    const forms = [];

    function btn(label, cls, fn) {
      const b = el('button', 'hud-btn' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { try { if (opts.unlockAudio) opts.unlockAudio(); if (fn) fn(); } catch (e) { warnOnce(e); } b.blur(); });
      return b;
    }
    function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
    function section(title) { const s = el('div', 'hud-section'); s.appendChild(el('div', 'hud-h', title)); return s; }
    function buildCheat() {
      const g = el('div', 'hud-cheat');
      for (const [k, a] of CHEAT) {
        const kk = el('span', 'k');
        k.split(' · ').forEach((part, i) => { if (i) kk.appendChild(document.createTextNode(' ')); kk.appendChild(el('span', 'hud-kbd', part)); });
        g.appendChild(kk); g.appendChild(el('span', 'a', a));
      }
      return g;
    }
    function buildSettings() {
      const wrap = el('div', 'hud-settings'), ctls = {};
      for (const f of FIELDS) {
        const row = el('div', 'hud-field'), ctl = el('div', 'ctl');
        row.appendChild(el('label', null, f.label));
        let input, val = null;
        if (f.type === 'range') {
          input = el('input'); input.type = 'range'; input.min = f.min; input.max = f.max; input.step = f.step;
          val = el('span', 'val'); ctl.appendChild(input); ctl.appendChild(val);
        } else if (f.type === 'check') {
          input = el('input'); input.type = 'checkbox'; ctl.appendChild(input);
        } else {
          input = el('select');
          for (const o of f.options) { const op = el('option', null, o); op.value = o; input.appendChild(op); }
          ctl.appendChild(input);
          if (f.note) ctl.appendChild(el('span', 'hud-note', f.note));
        }
        input.addEventListener(f.type === 'range' ? 'input' : 'change', () => {
          try {
            const v = f.type === 'range' ? parseFloat(input.value) : f.type === 'check' ? input.checked : input.value;
            const s = FS.settings;
            if (s) { s[f.key] = v; if (typeof s.save === 'function') s.save(); }
            if (f.key === 'cameraMode' && game().setCameraMode) game().setCameraMode(v);
            if (val) val.textContent = Number(v).toFixed(1);
            if (opts.unlockAudio) opts.unlockAudio();
            if (opts.onSettingsChanged) opts.onSettingsChanged();
          } catch (e) { warnOnce(e); }
        });
        ctls[f.key] = { input, val };
        row.appendChild(ctl); wrap.appendChild(row);
      }
      wrap.appendChild(el('div', 'hud-note', 'Quality changes apply after a reload. Sound starts after your first click.'));
      forms.push(ctls);
      return wrap;
    }
    function syncSettings() {
      const s = FS.settings || {};
      for (const ctls of forms) for (const f of FIELDS) {
        const c = ctls[f.key]; if (!c) continue;
        const v = s[f.key];
        if (f.type === 'range') { const n = num(v, 1); c.input.value = n; c.val.textContent = n.toFixed(1); }
        else if (f.type === 'check') c.input.checked = !!v;
        else c.input.value = f.options.indexOf(v) >= 0 ? v : f.options[0];
      }
    }
    function buildCards() {
      const list = el('div', 'hud-cards');
      const scs = Array.isArray(game().scenarios) ? game().scenarios : [];
      if (!scs.length) list.appendChild(el('div', 'hud-note', 'No scenarios available.'));
      for (const sc of scs) {
        const c = el('button', 'hud-card'); c.type = 'button';
        const kind = sc.kind === 'takeoff' ? 'takeoff' : sc.kind === 'final' ? 'final' : 'airborne';
        c.appendChild(el('span', 'kind ' + kind, kind.toUpperCase()));
        c.appendChild(el('div', 'ttl', sc.title || sc.id));
        if (sc.subtitle) c.appendChild(el('div', 'sub', sc.subtitle));
        c.addEventListener('click', () => { try { if (opts.unlockAudio) opts.unlockAudio(); if (game().start) game().start(sc.id); } catch (e) { warnOnce(e); } c.blur(); });
        list.appendChild(c);
      }
      return list;
    }

    // -- containers (order = stacking order) --
    const toasts = el('div'); toasts.id = 'hud-toasts';
    const bigToasts = el('div'); bigToasts.id = 'hud-bigtoasts';
    const paused = el('div'); paused.id = 'hud-paused'; paused.hidden = true;
    const pbox = el('div', 'hud-panel box');
    pbox.appendChild(el('div', 't', 'PAUSED')); pbox.appendChild(el('div', 's', 'Press P to resume · Esc for menu'));
    paused.appendChild(pbox);

    // crash overlay (non-modal)
    const crashWrap = el('div', 'hud-float'); crashWrap.hidden = true;
    const crashPanel = el('div', 'hud-panel hud-crash');
    crashPanel.appendChild(el('div', 'hud-title t', 'CRASHED'));
    const crashReason = el('div', 'r'); crashPanel.appendChild(crashReason);
    crashPanel.appendChild(el('div', 's', 'Press R to restart · Esc for menu'));
    const crashRow = el('div', 'hud-row');
    crashRow.appendChild(btn('Restart', 'primary', () => { hideCrash(); if (game().restart) game().restart(); }));
    crashRow.appendChild(btn('Menu', '', () => { if (game().openMenu) game().openMenu(); }));
    crashPanel.appendChild(crashRow); crashWrap.appendChild(crashPanel);

    // landing report (non-modal)
    const reportWrap = el('div', 'hud-float'); reportWrap.hidden = true;
    const reportPanel = el('div', 'hud-panel hud-report');
    const rHead = el('div', 'head'), rTitle = el('div', 'hud-title t'), rGrade = el('div', 'grade');
    rHead.appendChild(rTitle); rHead.appendChild(rGrade); reportPanel.appendChild(rHead);
    const rTable = el('table'), rBody = el('tbody'); rTable.appendChild(rBody); reportPanel.appendChild(rTable);
    const rComment = el('div', 'c'); reportPanel.appendChild(rComment);
    const rRow = el('div', 'hud-row');
    rRow.appendChild(btn('Continue', 'primary', hideReport));
    rRow.appendChild(btn('Take off again', '', () => { const end = lastReport && lastReport.runwayEnd; hideReport(); if (opts.takeoffAgain) opts.takeoffAgain(end); }));
    reportPanel.appendChild(rRow); reportWrap.appendChild(reportPanel);

    // start menu
    const startModal = el('div', 'hud-modal'); startModal.hidden = true;
    const startPanel = el('div', 'hud-panel hud-start');
    const sLeft = el('div'), sRight = el('div');
    sLeft.appendChild(el('div', 'hud-title big-title', 'TAIPEI SKIES'));
    sLeft.appendChild(el('div', 'under', 'A flight over Taipei'));
    sLeft.appendChild(el('div', 'tag', 'Fly Songshan, Xinyi and Yangmingshan · land on runway 10'));
    const sCards = el('div'); sLeft.appendChild(sCards);
    const sCtl = section('Controls'); sCtl.appendChild(buildCheat()); sRight.appendChild(sCtl);
    const sSet = section('Settings'); sSet.appendChild(buildSettings()); sRight.appendChild(sSet);
    const sHelpRow = el('div', 'hud-row'); sHelpRow.appendChild(btn('Help · how to land', '', () => showHelp())); sRight.appendChild(sHelpRow);
    startPanel.appendChild(sLeft); startPanel.appendChild(sRight); startModal.appendChild(startPanel);

    // in-game menu
    const menuModal = el('div', 'hud-modal'); menuModal.hidden = true;
    const menuPanel = el('div', 'hud-panel hud-menu');
    menuPanel.appendChild(el('div', 'hud-title', 'MENU'));
    const mSub = el('div', 'sub-title'); menuPanel.appendChild(mSub);
    const mStack = el('div', 'stack');
    const mCards = el('div'); mCards.hidden = true;
    const mSettings = el('div'); mSettings.hidden = true; mSettings.appendChild(buildSettings());
    mStack.appendChild(btn('Resume', 'primary wide', () => { if (game().closeMenu) game().closeMenu(); else hideAll(); }));
    mStack.appendChild(btn('Restart scenario', 'wide', () => { if (game().restart) game().restart(); }));
    mStack.appendChild(btn('Change scenario', 'wide', () => { mSettings.hidden = true; mCards.hidden = !mCards.hidden; if (!mCards.hidden) { clear(mCards); mCards.appendChild(buildCards()); } }));
    mStack.appendChild(mCards);
    mStack.appendChild(btn('Settings', 'wide', () => { mCards.hidden = true; mSettings.hidden = !mSettings.hidden; }));
    mStack.appendChild(mSettings);
    mStack.appendChild(btn('Help', 'wide', () => showHelp()));
    menuPanel.appendChild(mStack); menuModal.appendChild(menuPanel);

    // help
    const helpModal = el('div', 'hud-modal'); helpModal.hidden = true;
    const helpPanel = el('div', 'hud-panel hud-help');
    helpPanel.appendChild(el('div', 'hud-title', 'HELP'));
    const hCtl = section('Controls'); hCtl.appendChild(buildCheat()); helpPanel.appendChild(hCtl);
    const hLand = section('How to land'); const ol = el('ol', 'hud-primer');
    for (const step of [
      'Pick a runway with L (nearest first). Songshan runway 10 is the one downtown; its ILS is tuned for you.',
      'Follow the magenta steer marker and fly through the guidance rings; they line you up on a 3° glideslope.',
      'Keep the localizer (bottom) and glideslope (right) diamonds centered — both turn green when established.',
      'PAPI lights by the runway: two white, two red means on the slope. All white is high, all red is low.',
      'Short final: full flaps (F), about 65 kt, sink 500–700 ft/min, nose slightly up.',
      'At 20 ft flare gently, throttle to idle, let the mains touch first. Hold the centerline with the rudder.',
      'After touchdown: brakes (B), keep it straight, exit the runway. The report card grades the landing.',
    ]) ol.appendChild(el('li', null, step));
    hLand.appendChild(ol); helpPanel.appendChild(hLand);
    const hRow = el('div', 'hud-row'); hRow.appendChild(btn('Back', 'primary', helpBack)); helpPanel.appendChild(hRow);
    helpModal.appendChild(helpPanel);

    const modals = el('div'); modals.id = 'hud-modals';
    modals.appendChild(startModal); modals.appendChild(menuModal); modals.appendChild(helpModal);
    for (const e of [toasts, bigToasts, paused, crashWrap, reportWrap, modals]) root.appendChild(e);

    // -- behaviour --
    function hidePanels() { startModal.hidden = true; menuModal.hidden = true; helpModal.hidden = true; }
    function showStart() { hidePanels(); clear(sCards); sCards.appendChild(buildCards()); syncSettings(); startModal.hidden = false; }
    function showMenu() {
      hidePanels(); mCards.hidden = true; mSettings.hidden = true;
      const sc = game().scenario; setText(mSub, sc && sc.title ? sc.title : '');
      syncSettings(); menuModal.hidden = false;
    }
    function showHelp() { helpReturn = !startModal.hidden ? 'start' : !menuModal.hidden ? 'menu' : null; hidePanels(); helpModal.hidden = false; }
    function helpBack() {
      helpModal.hidden = true;
      if (helpReturn === 'start') showStart(); else if (helpReturn === 'menu') showMenu(); else if (opts.onHelpClose) opts.onHelpClose();
    }
    function hideAll() { hidePanels(); hideReport(); }
    function isOpen() { return !startModal.hidden || !menuModal.hidden || !helpModal.hidden; }
    function showCrash(reason) { setText(crashReason, reason || 'Crashed'); hideReport(); crashWrap.hidden = false; }
    function hideCrash() { crashWrap.hidden = true; }
    function setPaused(on) { paused.hidden = !on; }

    function row(label, value, cls, hint) {
      const tr = el('tr'), l = el('td', 'l', label), v = el('td', 'v' + (cls ? ' ' + cls : ''), value);
      if (hint) v.appendChild(el('span', 'hint', hint));
      tr.appendChild(l); tr.appendChild(v); rBody.appendChild(tr);
    }
    function showLandingReport(data, extra) {
      data = data || {}; extra = extra || {}; lastReport = data;
      const end = data.runwayEnd || null;
      const rate = Math.abs(num(data.vs, 0)) * MS_TO_FPM, off = num(data.crossTrack, 0), along = num(data.alongFromThreshold, 0);
      const gs = num(data.speed, 0) * MS_TO_KT;
      let g;
      if (!end) g = rate < 300 ? 'C' : 'D';
      else if (rate < 150 && Math.abs(off) < 5 && along >= 150 && along <= 600) g = 'A';
      else if (rate < 300 && Math.abs(off) < 10) g = 'B';
      else if (rate < 500 && Math.abs(off) < 20) g = 'C';
      else g = 'D';
      setText(rTitle, end ? 'LANDED · ' + tgtLabel(end) : 'LANDED OFF-AIRPORT');
      rGrade.className = 'grade ' + g; setText(rGrade, g);
      clear(rBody);
      row('Touchdown rate', '-' + fmtInt(rate) + ' ft/min', rate < 150 ? 'v-good' : rate < 300 ? 'v-warn' : 'v-bad');
      if (end) {
        row('Centerline', Math.abs(off).toFixed(1) + ' m ' + (off < 0 ? 'L' : 'R'), Math.abs(off) < 5 ? 'v-good' : Math.abs(off) < 10 ? 'v-warn' : 'v-bad');
        row('Past threshold', fmtInt(along) + ' m', along >= 150 && along <= 600 ? 'v-good' : 'v-warn', 'ideal 150–600 m');
      }
      row('Ground speed', fmtInt(gs) + ' kt', '');
      if (num(extra.gatesTotal, 0) > 0) row('Gates', num(extra.gatesPassed, 0) + '/' + extra.gatesTotal, '');
      const list = COMMENTS[g];
      let comment = end ? list[Math.round(rate + Math.abs(off)) % list.length] : 'Off-airport landing — no runway under you.';
      if (end && along > 600) comment += ' Landed long — the far end came up fast.';
      else if (end && along < 150) comment += ' Short of the touchdown zone — a bit low on the approach.';
      setText(rComment, comment);
      clearTimeout(reportTimer);
      reportTimer = setTimeout(hideReport, 12000);
      reportWrap.hidden = false;
    }
    function hideReport() { clearTimeout(reportTimer); reportTimer = 0; reportWrap.hidden = true; }
    function toast(text, ms, o) {
      ms = clamp(num(ms, 2500), 300, 60000); o = o || {};
      const holder = o.big ? bigToasts : toasts;
      const t = el('div', o.big ? 'big' : 'hud-chip head', String(text == null ? '' : text));
      holder.appendChild(t);
      while (holder.children.length > (o.big ? 2 : 5)) holder.removeChild(holder.firstChild);
      setTimeout(() => t.classList.add('hud-fade'), Math.max(0, ms - 400));
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, ms);
    }

    return { showStart, showMenu, showHelp, hideAll, isOpen, showCrash, hideCrash, showLandingReport, hideReport, setPaused, toast, syncSettings,
      els: { modals, toasts, paused, crash: crashWrap, report: reportWrap } };
  }

  // ---------------------------------------------------------------
  // Overlay chrome: root, HUD canvas, chips, buttons, minimap panel
  // ---------------------------------------------------------------
  let root = null, canvas = null, ctx = null, chipsEl = null, btnEl = null, mapPanel = null, mapCanvas = null, mapRangeEl = null;
  const chips = {}, buttons = {};
  let menus = null, audio = null, tmpV = null;
  let W = 1, H = 1, dpr = 1, S = 1, lastW = -1, lastH = -1;
  let mapRange = 6000;
  let now = 0, domTimer = 1, airborneT = 0, lastReportT = -1e9, landed = false, helpFromHotkey = false, pausedShown = false;
  let terrainT = 0, terrainFlag = false;
  let chipsRight = 0, chipsBottom = 0, btnLeft = Infinity, btnBottom = 0;

  function mkBtn(label, fn) {
    const b = el('button', 'hud-btn small', label);
    b.type = 'button';
    b.addEventListener('click', () => { try { if (audio) { audio.unlock(); audio.click(); } fn(); } catch (e) { warnOnce(e); } b.blur(); });
    return b;
  }
  function buildDom() {
    const app = document.getElementById('app') || document.body;
    root = el('div'); root.id = 'hud-root';
    canvas = el('canvas'); canvas.id = 'hud-canvas'; root.appendChild(canvas);
    ctx = canvas.getContext('2d');
    chipsEl = el('div'); chipsEl.id = 'hud-chips';
    chips.scenario = el('div', 'hud-chip head'); chips.phase = el('div', 'hud-chip head phase');
    chips.target = el('div', 'hud-chip'); chips.fps = el('div', 'hud-chip');
    for (const k of ['scenario', 'phase', 'target', 'fps']) chipsEl.appendChild(chips[k]);
    root.appendChild(chipsEl);
    btnEl = el('div'); btnEl.id = 'hud-buttons';
    buttons.menu = mkBtn('Menu', () => { const g = FS.game; if (g && g.running && g.openMenu) g.openMenu(); else showStartMenu(); });
    buttons.map = mkBtn('Map 6 km', cycleMinimap);
    buttons.cam = mkBtn('Cam', () => { const g = FS.game; if (g && g.cycleCamera) g.cycleCamera(); });
    buttons.snd = mkBtn('Sound', toggleSound);
    for (const k of ['menu', 'map', 'cam', 'snd']) btnEl.appendChild(buttons[k]);
    root.appendChild(btnEl);
    mapPanel = el('div', 'hud-panel'); mapPanel.id = 'hud-minimap'; mapPanel.hidden = true;
    mapCanvas = el('canvas'); mapCanvas.width = 240; mapCanvas.height = 240; mapPanel.appendChild(mapCanvas);
    const bar = el('div', 'bar'); bar.appendChild(el('span', null, 'Map · N up · M'));
    mapRangeEl = el('b', null, '6 km'); bar.appendChild(mapRangeEl); mapPanel.appendChild(bar);
    mapPanel.addEventListener('click', () => { try { if (audio) audio.unlock(); cycleMinimap(); } catch (e) { warnOnce(e); } });
    root.appendChild(mapPanel);
    app.appendChild(root);
  }

  function resize() {
    W = Math.max(1, window.innerWidth || 1); H = Math.max(1, window.innerHeight || 1);
    lastW = W; lastH = H;
    dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    S = clamp(Math.min(W / 1280, H / 720), 0.45, 1.5);
    sizeMinimap();
    domTimer = 1;
  }
  function sizeMinimap() {
    const size = (W <= 700 || H <= 520) ? 150 : 240;
    const px = Math.round(size * dpr);
    if (mapCanvas.width !== px || mapCanvas.height !== px) { mapCanvas.width = px; mapCanvas.height = px; }
  }

  // ---------------------------------------------------------------
  // Aircraft state snapshot with defaults (never trust a peer field)
  // ---------------------------------------------------------------
  const st = { airspeed: 0, groundSpeed: 0, altitude: 0, agl: 0, heading: 0, pitch: 0, roll: 0, vs: 0, alpha: 0, beta: 0, throttle: 0, rpm: NaN,
    flaps: 0, brakes: false, onGround: true, onRunway: null, crashed: false, crashReason: '', stall: false, gForce: 1, mouseActive: false,
    vel: null, forward: null, pos: null };
  function readState() {
    const s = (FS.aircraft && FS.aircraft.state) || null;
    st.airspeed = Math.max(0, num(s && s.airspeed, 0));
    st.groundSpeed = Math.max(0, num(s && s.groundSpeed, st.airspeed));
    st.altitude = num(s && s.altitude, 0);
    st.agl = num(s && s.agl, st.altitude);
    st.heading = wrap360(num(s && s.heading, 0));
    st.pitch = num(s && s.pitch, 0); st.roll = num(s && s.roll, 0); st.vs = num(s && s.vs, 0);
    st.alpha = num(s && s.alpha, 0); st.beta = num(s && s.beta, 0);
    st.throttle = clamp(num(s && s.throttle, 0), 0, 1); st.rpm = num(s && s.rpm, NaN);
    st.flaps = clamp(num(s && s.flaps, 0), 0, 1); st.gForce = num(s && s.gForce, 1);
    st.brakes = !!(s && s.brakes); st.onGround = s ? !!s.onGround : true; st.onRunway = (s && s.onRunway) || null;
    st.crashed = !!(s && s.crashed); st.crashReason = (s && s.crashReason) || ''; st.stall = !!(s && s.stall);
    st.mouseActive = !!(s && s.mouseActive) || !!(FS.input && FS.input.mouse && FS.input.mouse.active);
    st.vel = s && isVec(s.vel) ? s.vel : null; st.forward = s && isVec(s.forward) ? s.forward : null; st.pos = s && isVec(s.pos) ? s.pos : null;
    return st;
  }
  const vsp = { rotate: 28, approach: 33, stall: 24, stallFlaps: 21, cruise: 60, never: 82 };
  function vSpeeds() {
    const v = (FS.aircraft && FS.aircraft.params && FS.aircraft.params.vSpeeds) || null;
    if (v) for (const k in vsp) vsp[k] = num(v[k], vsp[k]);
    return vsp;
  }
  function guidance() { return (FS.nav && FS.nav.guidance) || {}; }

  // ---------------------------------------------------------------
  // DOM refresh (~4 Hz): chips, button labels, cached layout
  // ---------------------------------------------------------------
  function refreshDom(s, g, running) {
    const game = FS.game || {}, settings = FS.settings || {};
    chipsEl.hidden = !running || settings.hud === false;
    if (running) {
      setText(chips.scenario, (game.scenario && game.scenario.title) || 'Taipei Skies');
      const phase = s.crashed ? 'CRASHED' : (landed && s.onGround) ? 'LANDED' : (PHASE_LABEL[g.phase] || 'FREE FLIGHT');
      setText(chips.phase, phase);
      chips.phase.classList.toggle('landed', phase === 'LANDED');
      chips.phase.classList.toggle('crashed', phase === 'CRASHED');
      const t = g.target;
      chips.target.hidden = !t;
      if (t) setText(chips.target, tgtLabel(t) + ' · ' + (num(g.dist, 0) * M_TO_NM).toFixed(1) + ' nm');
      chips.fps.hidden = !settings.showFps;
      if (settings.showFps) setText(chips.fps, 'FPS ' + fmtInt(num(game.fps, 0)));
    }
    refreshButtons();
    const cr = chipsEl.hidden ? null : chipsEl.getBoundingClientRect();
    chipsRight = cr ? cr.right : 0; chipsBottom = cr ? cr.bottom : 0;
    const br = btnEl.getBoundingClientRect();
    btnLeft = br.width ? br.left : Infinity; btnBottom = br.bottom;
  }
  function refreshButtons() {
    if (!btnEl) return;
    const game = FS.game || {}, settings = FS.settings || {};
    setText(buttons.map, mapRange ? 'Map ' + (mapRange / 1000) + ' km' : 'Map off');
    setText(buttons.cam, 'Cam ' + (game.cameraMode || settings.cameraMode || 'chase'));
    setText(buttons.snd, 'Sound ' + (settings.sound === false ? 'off' : 'on'));
    setText(mapRangeEl, mapRange ? (mapRange / 1000) + ' km' : 'off');
  }

  // ---------------------------------------------------------------
  // Minimap panel: FS.nav draws it; a plain fallback keeps it alive
  // ---------------------------------------------------------------
  function drawMinimap(s, g, running) {
    const show = running && mapRange > 0;
    if (mapPanel.hidden === show) { mapPanel.hidden = !show; if (show) sizeMinimap(); }
    if (!show) return;
    const nav = FS.nav;
    if (nav && typeof nav.drawMinimap === 'function') {
      try { nav.drawMinimap(mapCanvas, mapRange); return; } catch (e) { warnOnce(e); }
    }
    drawMinimapFallback(s, g);
  }
  function drawMinimapFallback(s, g) {
    const k = mapCanvas.getContext('2d'); if (!k) return;
    const size = mapCanvas.width, sc = size / (2 * mapRange), c = size / 2;
    const px = s.pos ? s.pos.x : 0, pz = s.pos ? s.pos.z : 0;
    k.setTransform(1, 0, 0, 1, 0, 0);
    k.fillStyle = '#0b1a26'; k.fillRect(0, 0, size, size);
    const step = mapRange >= 20000 ? 5000 : 1000;
    k.strokeStyle = 'rgba(79,227,255,.12)'; k.lineWidth = 1;
    for (let gx = Math.floor((px - mapRange) / step) * step; gx <= px + mapRange; gx += step) { const x = c + (gx - px) * sc; k.beginPath(); k.moveTo(x, 0); k.lineTo(x, size); k.stroke(); }
    for (let gz = Math.floor((pz - mapRange) / step) * step; gz <= pz + mapRange; gz += step) { const y = c + (gz - pz) * sc; k.beginPath(); k.moveTo(0, y); k.lineTo(size, y); k.stroke(); }
    const t = g.target;
    if (t && t.threshold && t.dir) {
      const len = num(t.length, 2600);
      k.strokeStyle = COL.cyan; k.lineWidth = Math.max(2, 60 * sc);
      k.beginPath(); k.moveTo(c + (t.threshold.x - px) * sc, c + (t.threshold.z - pz) * sc);
      k.lineTo(c + (t.threshold.x + t.dir.x * len - px) * sc, c + (t.threshold.z + t.dir.z * len - pz) * sc); k.stroke();
    }
    if (g.wp) {
      const x = c + (num(g.wp.x, px) - px) * sc, y = c + (num(g.wp.z, pz) - pz) * sc;
      k.fillStyle = COL.magenta; k.beginPath(); k.moveTo(x, y - 5); k.lineTo(x + 5, y); k.lineTo(x, y + 5); k.lineTo(x - 5, y); k.closePath(); k.fill();
    }
    k.save(); k.translate(c, c); k.rotate(s.heading * D2R);
    k.fillStyle = COL.green; k.beginPath(); k.moveTo(0, -9); k.lineTo(6, 8); k.lineTo(0, 4); k.lineTo(-6, 8); k.closePath(); k.fill();
    k.restore();
    k.fillStyle = COL.dim; k.font = '600 ' + Math.round(size / 18) + 'px ' + FONT_HEAD; k.textAlign = 'left'; k.textBaseline = 'top';
    k.fillText('N', 6, 4);
  }

  // ---------------------------------------------------------------
  // Canvas helpers: every symbol gets a dark halo for legibility
  // ---------------------------------------------------------------
  function font(px, head, weight) { return (weight || (head ? 600 : 500)) + ' ' + Math.max(8, Math.round(px)) + 'px ' + (head ? FONT_HEAD : FONT_MONO); }
  function text(str, x, y, o) {
    o = o || {};
    ctx.font = o.font || font(12 * S);
    ctx.textAlign = o.align || 'center'; ctx.textBaseline = o.base || 'middle';
    if (o.outline !== false) { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, 3 * S); ctx.strokeStyle = COL.outline; ctx.strokeText(str, x, y); }
    ctx.fillStyle = o.color || COL.green; ctx.fillText(str, x, y);
  }
  function measure(str, f) { ctx.font = f; return ctx.measureText(str).width; }
  function stroke(color, width, build, dash) {
    ctx.beginPath(); build();
    if (dash) ctx.setLineDash(dash);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = width + 2; ctx.strokeStyle = COL.outline; ctx.stroke();
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }
  function line(color, width, build, dash) {
    ctx.beginPath(); build();
    if (dash) ctx.setLineDash(dash);
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }
  function fillShape(color, build, outline) {
    ctx.beginPath(); build();
    if (outline !== false) { ctx.lineJoin = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = COL.outline; ctx.stroke(); }
    ctx.fillStyle = color; ctx.fill();
  }
  function poly(pts, fill, strokeCol, lw) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (strokeCol) { ctx.lineJoin = 'round'; ctx.lineWidth = lw || 1.5; ctx.strokeStyle = strokeCol; ctx.stroke(); }
  }
  function box(x, y, w, h, r, fill, strokeCol) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (strokeCol) { ctx.lineWidth = 1; ctx.strokeStyle = strokeCol; ctx.stroke(); }
  }
  function diamond(x, y, r, color, filled) {
    const p = () => { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); };
    if (filled) fillShape(color, p); else stroke(color, Math.max(1.5, 2 * S), p);
  }
  const lw = () => Math.max(1.5, 2 * S);

  // ---------------------------------------------------------------
  // Attitude: horizon, pitch ladder, flight-path vector, roll scale
  // ---------------------------------------------------------------
  function flightPath(s) {
    const v = s.vel;
    if (v && Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) > 3) {
      const hs = Math.hypot(v.x, v.z);
      const gamma = Math.atan2(v.y, Math.max(hs, 1e-3)) * R2D;
      const track = hs > 0.5 ? Math.atan2(v.x, -v.z) * R2D : s.heading;
      return { gamma: clamp(gamma, -60, 60), drift: wrap180(track - s.heading) };
    }
    if (s.airspeed > 3) return { gamma: Math.asin(clamp(s.vs / s.airspeed, -1, 1)) * R2D, drift: 0 };
    return { gamma: s.pitch, drift: 0 };
  }
  function drawAttitude(s) {
    const cx = W / 2, cy = H / 2, ppd = 9 * S, R = 170 * S, w = lw();
    const pitch = clamp(s.pitch, -89, 89), roll = s.roll;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(-roll * D2R);
    const hy = pitch * ppd;
    stroke(COL.green, w, () => { ctx.moveTo(-R * 1.6, hy); ctx.lineTo(-44 * S, hy); ctx.moveTo(44 * S, hy); ctx.lineTo(R * 1.6, hy); });
    const lf = font(12 * S);
    for (let a = -30; a <= 30; a += 5) {
      if (a === 0) continue;
      const y = (pitch - a) * ppd;
      if (Math.abs(y) > R + 12) continue;
      const major = a % 10 === 0, hw = (major ? 60 : 32) * S, gap = 26 * S, tick = 7 * S * (a > 0 ? 1 : -1);
      stroke(COL.green, w, () => {
        ctx.moveTo(-hw, y); ctx.lineTo(-gap, y); ctx.lineTo(-gap, y + tick);
        ctx.moveTo(hw, y); ctx.lineTo(gap, y); ctx.lineTo(gap, y + tick);
      }, a < 0 ? [7 * S, 5 * S] : null);
      if (major) { text(String(Math.abs(a)), -hw - 13 * S, y, { font: lf }); text(String(Math.abs(a)), hw + 13 * S, y, { font: lf }); }
    }
    const fp = flightPath(s);
    const fx = clamp(fp.drift, -18, 18) * ppd, fy = clamp((pitch - fp.gamma) * ppd, -R + 26 * S, R - 26 * S), r = 7 * S;
    stroke(COL.green, w, () => {
      ctx.moveTo(fx + r, fy); ctx.arc(fx, fy, r, 0, Math.PI * 2);
      ctx.moveTo(fx - r, fy); ctx.lineTo(fx - r - 13 * S, fy);
      ctx.moveTo(fx + r, fy); ctx.lineTo(fx + r + 13 * S, fy);
      ctx.moveTo(fx, fy - r); ctx.lineTo(fx, fy - r - 8 * S);
    });
    ctx.restore();
    // fixed aircraft symbol (waterline)
    stroke(COL.green, w + 0.5, () => {
      ctx.moveTo(cx - 64 * S, cy); ctx.lineTo(cx - 28 * S, cy); ctx.lineTo(cx - 14 * S, cy + 10 * S); ctx.lineTo(cx, cy);
      ctx.lineTo(cx + 14 * S, cy + 10 * S); ctx.lineTo(cx + 28 * S, cy); ctx.lineTo(cx + 64 * S, cy);
    });
    // roll scale + sky pointer + slip index
    const Ra = R + 14 * S;
    stroke(COL.green, w * 0.75, () => { ctx.arc(cx, cy, Ra, -150 * D2R, -30 * D2R); });
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const th = (-90 + a) * D2R;
      if (a === 0) { fillShape(COL.green, () => { ctx.moveTo(cx, cy - Ra); ctx.lineTo(cx - 6 * S, cy - Ra - 11 * S); ctx.lineTo(cx + 6 * S, cy - Ra - 11 * S); ctx.closePath(); }); continue; }
      const len = (a % 30 === 0 ? 12 : Math.abs(a) === 45 ? 9 : 6) * S;
      stroke(COL.green, w * 0.75, () => { ctx.moveTo(cx + Math.cos(th) * Ra, cy + Math.sin(th) * Ra); ctx.lineTo(cx + Math.cos(th) * (Ra + len), cy + Math.sin(th) * (Ra + len)); });
    }
    const bth = (-90 - clamp(roll, -66, 66)) * D2R;
    ctx.save();
    ctx.translate(cx + Math.cos(bth) * (Ra - 3 * S), cy + Math.sin(bth) * (Ra - 3 * S)); ctx.rotate(bth + Math.PI / 2);
    fillShape(COL.green, () => { ctx.moveTo(0, 0); ctx.lineTo(-6 * S, 11 * S); ctx.lineTo(6 * S, 11 * S); ctx.closePath(); });
    const slip = clamp(s.beta, -10, 10) * 1.2 * S;
    stroke(COL.green, w * 0.75, () => { ctx.rect(-7 * S + slip, 13 * S, 14 * S, 4 * S); });
    ctx.restore();
  }

  // ---------------------------------------------------------------
  // Airspeed tape (knots) with speed bands, cue bug, V_R marker
  // ---------------------------------------------------------------
  function drawAirspeed(s, g, v) {
    const cx = W / 2, cy = H / 2, x = cx - 250 * S, th = 140 * S, tw = 62 * S, ppk = 3.2 * S, w = lw(), K = MS_TO_KT;
    const kt = s.airspeed * K, top = cy - th, bot = cy + th;
    const yOf = (k) => cy - (k - kt) * ppk;
    ctx.fillStyle = COL.box; ctx.fillRect(x - tw, top, tw, th * 2);
    ctx.save(); ctx.beginPath(); ctx.rect(x - tw - 2, top, tw + 12 * S, th * 2); ctx.clip();
    const band = (k0, k1, col, bx, bw) => { const y1 = clamp(yOf(k0), top, bot), y0 = clamp(yOf(k1), top, bot); if (y1 > y0) { ctx.fillStyle = col; ctx.fillRect(bx, y0, bw, y1 - y0); } };
    band(v.stallFlaps * K, 85, 'rgba(255,255,255,.85)', x + 2 * S, 3 * S);
    band(v.stall * K, v.cruise * K * 1.1, COL.green, x + 6 * S, 3 * S);
    band(v.cruise * K * 1.1, v.never * K, COL.amber, x + 6 * S, 3 * S);
    band(v.never * K, v.never * K + 400, COL.red, x + 6 * S, 3 * S);
    const yn = yOf(v.never * K);
    if (yn > top && yn < bot) stroke(COL.red, 3 * S, () => { ctx.moveTo(x - 12 * S, yn); ctx.lineTo(x + 10 * S, yn); });
    const lf = font(12 * S), k0 = Math.floor((kt - th / ppk) / 5) * 5, k1 = kt + th / ppk;
    for (let k = Math.max(0, k0); k <= k1; k += 5) {
      const y = yOf(k), major = k % 10 === 0;
      stroke(COL.green, w * 0.75, () => { ctx.moveTo(x, y); ctx.lineTo(x - (major ? 10 : 5) * S, y); });
      if (major && Math.abs(y - cy) > 17 * S) text(String(k), x - 14 * S, y, { font: lf, align: 'right' });
    }
    ctx.restore();
    stroke(COL.green, w * 0.75, () => { ctx.moveTo(x, top); ctx.lineTo(x, bot); });
    const cue = num(g.speedCue, NaN);
    if (cue > 0) { const y = clamp(yOf(cue * K), top, bot); fillShape(COL.magenta, () => { ctx.moveTo(x + 1, y); ctx.lineTo(x + 9 * S, y - 6 * S); ctx.lineTo(x + 9 * S, y + 6 * S); ctx.closePath(); }); }
    if (g.phase === 'takeoff' && (s.onGround || s.agl < 60)) {
      const y = yOf(v.rotate * K);
      if (y > top && y < bot) {
        stroke(COL.cyan, w * 0.75, () => { ctx.moveTo(x + 1, y); ctx.lineTo(x + 9 * S, y); });
        text('Vᴿ ' + Math.round(v.rotate * K), x + 12 * S, y, { font: font(11 * S, true), color: COL.cyan, align: 'left' });
      }
    }
    const bh = 28 * S, over = s.airspeed > v.never;
    poly([[x - tw - 4 * S, cy - bh / 2], [x + 2 * S, cy - bh / 2], [x + 12 * S, cy], [x + 2 * S, cy + bh / 2], [x - tw - 4 * S, cy + bh / 2]], 'rgba(4,14,20,.92)', over ? COL.red : COL.green, 1.5);
    text(String(Math.round(kt)), x - 6 * S, cy + 1, { font: font(20 * S, false, 600), align: 'right', color: over ? COL.red : COL.green });
    text('IAS KT', x - tw / 2, top - 11 * S, { font: font(11 * S, true), color: COL.dim });
    text('GS ' + Math.round(s.groundSpeed * K) + ' kt', x - tw / 2, bot + 13 * S, { font: font(11 * S), color: COL.dim });
  }

  // ---------------------------------------------------------------
  // Altitude tape (feet MSL), radar altitude, desired-altitude bug, VSI
  // ---------------------------------------------------------------
  function drawAltitude(s, g) {
    const cx = W / 2, cy = H / 2, x = cx + 250 * S, th = 140 * S, tw = 64 * S, ppf = 0.22 * S, w = lw();
    const ft = s.altitude * M_TO_FT, top = cy - th, bot = cy + th;
    const yOf = (f) => cy - (f - ft) * ppf;
    ctx.fillStyle = COL.box; ctx.fillRect(x, top, tw, th * 2);
    ctx.save(); ctx.beginPath(); ctx.rect(x - 12 * S, top, tw + 12 * S + 2, th * 2); ctx.clip();
    const lf = font(12 * S), f0 = Math.floor((ft - th / ppf) / 100) * 100, f1 = ft + th / ppf;
    for (let f = f0; f <= f1; f += 100) {
      const y = yOf(f), major = f % 500 === 0;
      stroke(COL.green, w * 0.75, () => { ctx.moveTo(x, y); ctx.lineTo(x + (major ? 10 : 5) * S, y); });
      if (major && Math.abs(y - cy) > 17 * S) text(fmtInt(f), x + 14 * S, y, { font: lf, align: 'left' });
    }
    const da = num(g.desiredAlt, NaN);
    if (g.target && Number.isFinite(da)) { const y = clamp(yOf(da * M_TO_FT), top, bot); fillShape(COL.magenta, () => { ctx.moveTo(x - 1, y); ctx.lineTo(x - 9 * S, y - 6 * S); ctx.lineTo(x - 9 * S, y + 6 * S); ctx.closePath(); }); }
    ctx.restore();
    stroke(COL.green, w * 0.75, () => { ctx.moveTo(x, top); ctx.lineTo(x, bot); });
    const bh = 28 * S;
    poly([[x + tw + 4 * S, cy - bh / 2], [x - 2 * S, cy - bh / 2], [x - 12 * S, cy], [x - 2 * S, cy + bh / 2], [x + tw + 4 * S, cy + bh / 2]], 'rgba(4,14,20,.92)', COL.green, 1.5);
    text(fmtInt(Math.round(ft / 10) * 10), x + 6 * S, cy + 1, { font: font(20 * S, false, 600), align: 'left' });
    text('FT MSL', x + tw / 2, top - 11 * S, { font: font(11 * S, true), color: COL.dim });
    const aglFt = Math.max(0, s.agl * M_TO_FT);
    const aglCol = s.onGround ? COL.dim : aglFt < 200 ? COL.red : aglFt < 500 ? COL.amber : COL.green;
    text('AGL ' + fmtInt(aglFt) + ' ft', x + tw / 2, bot + 13 * S, { font: font(12 * S), color: aglCol });
    if (W >= 700) drawVSI(x + tw + 10 * S, cy, s);
  }
  function drawVSI(vx, cy, s) {
    const hh = 100 * S, w = lw();
    const map = (fpm) => { const a = Math.min(Math.abs(fpm), 2000); const t = a <= 1000 ? (a / 1000) * 0.62 : 0.62 + ((a - 1000) / 1000) * 0.38; return -Math.sign(fpm) * t * hh; };
    ctx.fillStyle = COL.box; ctx.fillRect(vx - 10 * S, cy - hh - 6 * S, 34 * S, hh * 2 + 12 * S);
    stroke(COL.green, w * 0.75, () => { ctx.moveTo(vx, cy - hh); ctx.lineTo(vx, cy + hh); });
    for (const v of [-2000, -1000, -500, 0, 500, 1000, 2000]) {
      const y = cy + map(v), major = v % 1000 === 0;
      stroke(COL.green, w * 0.75, () => { ctx.moveTo(vx, y); ctx.lineTo(vx + (major ? 7 : 4) * S, y); });
      if (major && v !== 0) text(String(Math.abs(v) / 1000), vx + 13 * S, y, { font: font(10 * S), align: 'left', color: COL.dim });
    }
    const fpm = clamp(s.vs * MS_TO_FPM, -2500, 2500), ny = cy + map(fpm);
    fillShape(COL.green, () => { ctx.moveTo(vx - 1, ny); ctx.lineTo(vx - 9 * S, ny - 5 * S); ctx.lineTo(vx - 9 * S, ny + 5 * S); ctx.closePath(); });
    const label = (fpm >= 0 ? '+' : '-') + fmtInt(Math.abs(Math.round(fpm / 10) * 10));
    text(label, vx + 6 * S, cy + (fpm >= 0 ? hh + 15 * S : -hh - 15 * S), { font: font(11 * S), color: Math.abs(fpm) > 1500 ? COL.amber : COL.green });
  }

  // ---------------------------------------------------------------
  // Heading tape with desired-heading bug and runway marker
  // ---------------------------------------------------------------
  const CARDINAL = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  function drawHeading(s, g) {
    const cx = W / 2, hy = H - 96 * S, hw = Math.min(180 * S, W / 2 - 16), ppd = 4 * S, w = lw(), hdg = s.heading;
    ctx.fillStyle = COL.box; ctx.fillRect(cx - hw, hy, hw * 2, 30 * S);
    ctx.save(); ctx.beginPath(); ctx.rect(cx - hw, hy - 12 * S, hw * 2, 44 * S); ctx.clip();
    const span = hw / ppd, d0 = Math.ceil((hdg - span) / 5) * 5, d1 = hdg + span;
    for (let d = d0; d <= d1; d += 5) {
      const x = cx + (d - hdg) * ppd, dd = wrap360(d), major = dd % 10 === 0;
      stroke(COL.green, w * 0.75, () => { ctx.moveTo(x, hy); ctx.lineTo(x, hy + (major ? 9 : 5) * S); });
      if (dd % 30 === 0) {
        const card = CARDINAL[dd];
        text(card || String(dd / 10).padStart(2, '0'), x, hy + 19 * S, { font: card ? font(14 * S, true, 700) : font(11 * S), color: card ? COL.white : COL.green });
      }
    }
    const t = g.target, rh = num(t && t.heading, NaN);
    if (Number.isFinite(rh)) {
      const dx = wrap180(rh - hdg) * ppd;
      if (Math.abs(dx) <= hw) stroke(COL.cyan, w * 0.75, () => { ctx.moveTo(cx + dx - 3 * S, hy - 9 * S); ctx.lineTo(cx + dx - 3 * S, hy - 1); ctx.moveTo(cx + dx + 3 * S, hy - 9 * S); ctx.lineTo(cx + dx + 3 * S, hy - 1); });
    }
    const dh = num(g.desiredHeading, NaN);
    if (t && Number.isFinite(dh)) {
      const off = wrap180(dh - hdg) * ppd, dx = clamp(off, -hw + 7 * S, hw - 7 * S), clamped = Math.abs(off) > hw - 7 * S;
      const p = () => { ctx.moveTo(cx + dx - 7 * S, hy - 1); ctx.lineTo(cx + dx - 7 * S, hy - 9 * S); ctx.lineTo(cx + dx - 3 * S, hy - 9 * S); ctx.lineTo(cx + dx, hy - 3 * S); ctx.lineTo(cx + dx + 3 * S, hy - 9 * S); ctx.lineTo(cx + dx + 7 * S, hy - 9 * S); ctx.lineTo(cx + dx + 7 * S, hy - 1); ctx.closePath(); };
      if (clamped) stroke(COL.magenta, w * 0.75, p); else fillShape(COL.magenta, p);
    }
    ctx.restore();
    stroke(COL.green, w * 0.75, () => { ctx.moveTo(cx - hw, hy); ctx.lineTo(cx + hw, hy); });
    const bw = 56 * S, bh = 24 * S, by = hy - 11 * S - bh;
    poly([[cx - bw / 2, by], [cx + bw / 2, by], [cx + bw / 2, by + bh], [cx + 6 * S, by + bh], [cx, hy - 1], [cx - 6 * S, by + bh], [cx - bw / 2, by + bh]], 'rgba(4,14,20,.92)', COL.green, 1.5);
    text(pad3(hdg) + '°', cx, by + bh / 2 + 1, { font: font(17 * S, false, 600) });
  }

  // ---------------------------------------------------------------
  // Status row: THR bar, RPM, FLAPS, BRK, GEAR, G, camera
  // ---------------------------------------------------------------
  function drawStatus(s) {
    const y0 = H - 48 * S, thr = s.throttle;
    const cam = String((FS.game && FS.game.cameraMode) || (FS.settings && FS.settings.cameraMode) || 'chase').toUpperCase();
    const rpm = Number.isFinite(s.rpm) ? s.rpm : 700 + thr * 1900;
    const items = [
      { label: 'THR', value: Math.round(thr * 100) + '%', bar: thr },
      { label: 'RPM', value: fmtInt(rpm) },
      { label: 'FLAPS', value: (s.flaps >= 0.99 ? 30 : s.flaps >= 0.4 ? 15 : 0) + '°' },
      { label: 'BRK', value: s.brakes ? 'SET' : 'OFF', color: s.brakes ? COL.amber : COL.dim },
      { label: 'GEAR', value: 'DN', color: COL.dim },
      { label: 'G', value: s.gForce.toFixed(1), color: s.gForce > 2.5 || s.gForce < 0 ? COL.amber : COL.green },
      { label: 'CAM', value: cam },
    ];
    const fl = font(11 * S, true), fv = font(13 * S, false, 500), gapIn = 5 * S, gapOut = 18 * S, barW = 40 * S, maxW = W - 24;
    const widths = items.map((it) => measure(it.label, fl) + gapIn + measure(it.value, fv) + (it.bar != null ? gapIn + barW : 0));
    const rows = [[]], rowW = [0];
    items.forEach((it, i) => {
      let r = rows.length - 1;
      if (rowW[r] > 0 && rowW[r] + gapOut + widths[i] > maxW) { rows.push([]); rowW.push(0); r++; }
      rowW[r] += (rowW[r] > 0 ? gapOut : 0) + widths[i]; rows[r].push(i);
    });
    rows.forEach((row, r) => {
      let x = W / 2 - rowW[r] / 2; const y = y0 + r * 18 * S;
      for (const i of row) {
        const it = items[i];
        text(it.label, x, y, { font: fl, align: 'left', color: COL.dim }); x += measure(it.label, fl) + gapIn;
        if (it.bar != null) {
          ctx.fillStyle = COL.outline; ctx.fillRect(x - 1, y - 4 * S - 1, barW + 2, 8 * S + 2);
          ctx.fillStyle = 'rgba(143,247,165,.22)'; ctx.fillRect(x, y - 4 * S, barW, 8 * S);
          ctx.fillStyle = COL.green; ctx.fillRect(x, y - 4 * S, barW * it.bar, 8 * S);
          x += barW + gapIn;
        }
        text(it.value, x, y, { font: fv, align: 'left', color: it.color || COL.green }); x += measure(it.value, fv) + gapOut;
      }
    });
  }

  // ---------------------------------------------------------------
  // ILS: localizer scale under the ladder, glideslope scale beside it
  // ---------------------------------------------------------------
  function ilsActive(g) { return !!g.target && (g.phase === 'landing' || !!g.onFinal); }
  function drawILS(s, g) {
    if (!ilsActive(g)) return;
    const cx = W / 2, cy = H / 2, R = 170 * S, w = lw(), col = g.established ? COL.green : COL.magenta, full = 80 * S, gap = 16 * S;
    const ly = cy + R + 22 * S, gx = cx + R + 24 * S;
    for (let i = -5; i <= 5; i++) {
      if (i === 0) continue;
      stroke(COL.dim, 1, () => { ctx.moveTo(cx + i * gap + 2.5 * S, ly); ctx.arc(cx + i * gap, ly, 2.5 * S, 0, Math.PI * 2); });
      stroke(COL.dim, 1, () => { ctx.moveTo(gx + 2.5 * S, cy + i * gap); ctx.arc(gx, cy + i * gap, 2.5 * S, 0, Math.PI * 2); });
    }
    stroke(COL.green, w * 0.75, () => { ctx.moveTo(cx, ly - 8 * S); ctx.lineTo(cx, ly + 8 * S); ctx.moveTo(gx - 8 * S, cy); ctx.lineTo(gx + 8 * S, cy); });
    const ld = num(g.locDev, 0), gd = num(g.gsDev, 0);
    diamond(cx + clamp(ld / 2.5, -1, 1) * full, ly, 7 * S, col, Math.abs(ld) <= 2.5);
    diamond(gx, cy + clamp(gd / 2.5, -1, 1) * full, 7 * S, col, Math.abs(gd) <= 2.5);
    text('LOC', cx - full - 18 * S, ly, { font: font(10 * S, true), color: COL.dim, align: 'right' });
    text('G/S', gx, cy - full - 14 * S, { font: font(10 * S, true), color: COL.dim });
  }
  function papiState(g, t) {
    let p = g.papi != null ? g.papi : (t && t.papiState);
    if (p == null) return null;
    if (typeof p === 'number') { const n = clamp(Math.round(p), 0, 4); return 'W'.repeat(n) + 'R'.repeat(4 - n); }
    if (Array.isArray(p)) p = p.map((v) => (v === true || v === 1 || v === 'W' || v === 'w' || v === 'white' ? 'W' : 'R')).join('');
    if (typeof p !== 'string') return null;
    p = p.toUpperCase().replace(/[^RW]/g, '');
    return p.length ? p.slice(0, 4).padEnd(4, p[p.length - 1]) : null;
  }

  // ---------------------------------------------------------------
  // Steer marker: projected waypoint diamond or an edge arrow
  // ---------------------------------------------------------------
  function drawSteer(s, g) {
    const wp = g.wp, cam = FS.camera;
    if (!wp || !cam || !window.THREE || !cam.projectionMatrix) return;
    if (!tmpV) tmpV = new THREE.Vector3();
    tmpV.set(num(wp.x, 0), num(wp.y, 0), num(wp.z, 0)).project(cam);
    const behind = !(tmpV.z <= 1) || !Number.isFinite(tmpV.x) || !Number.isFinite(tmpV.y);
    const sx = ((tmpV.x + 1) / 2) * W, sy = ((1 - tmpV.y) / 2) * H, cx = W / 2, cy = H / 2;
    const dist = s.pos ? Math.hypot(num(wp.x, 0) - s.pos.x, num(wp.z, 0) - s.pos.z) : NaN;
    const distStr = Number.isFinite(dist) ? (dist >= 1852 ? (dist * M_TO_NM).toFixed(1) + ' nm' : fmtInt(dist) + ' m') : '';
    const label = [wp.name ? String(wp.name) : '', distStr].filter(Boolean).join(' · ');
    const f = font(12 * S);
    if (!behind && sx > 40 * S && sx < W - 40 * S && sy > 70 * S && sy < H - 120 * S) {
      diamond(sx, sy, 10 * S, COL.magenta, false);
      fillShape(COL.magenta, () => { ctx.moveTo(sx + 2 * S, sy); ctx.arc(sx, sy, 2 * S, 0, Math.PI * 2); }, false);
      if (label) text(label, sx, sy + 21 * S, { font: f, color: COL.magenta });
      return;
    }
    let dx = behind ? cx - sx : sx - cx, dy = behind ? cy - sy : sy - cy;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) { dx = 0; dy = -1; }
    const len = Math.hypot(dx, dy); dx /= len; dy /= len;
    const hx = W / 2 - 50 * S, hy = H / 2 - 130 * S;
    const tt = Math.min(Math.abs(dx) > 1e-6 ? hx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? hy / Math.abs(dy) : Infinity);
    const ax = cx + dx * tt, ay = cy + dy * tt;
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.atan2(dy, dx));
    fillShape(COL.magenta, () => { ctx.moveTo(15 * S, 0); ctx.lineTo(-9 * S, -10 * S); ctx.lineTo(-3 * S, 0); ctx.lineTo(-9 * S, 10 * S); ctx.closePath(); });
    ctx.restore();
    if (label) text(label, clamp(ax - dx * 36 * S, 70 * S, W - 70 * S), ay - dy * 36 * S, { font: f, color: COL.magenta });
  }

  // ---------------------------------------------------------------
  // Top center: instruction strip, target line with PAPI, gates
  // ---------------------------------------------------------------
  function drawTop(s, g) {
    const cx = W / 2, t = g.target;
    const instr = typeof g.instruction === 'string' ? g.instruction.trim() : '';
    const items = [];
    if (ilsActive(g)) {
      const ref = Number.isFinite(num(g.desiredAlt, NaN)) ? g.desiredAlt : num(t.elev, 0);
      const err = (s.altitude - ref) * M_TO_FT;
      items.push({ text: tgtLabel(t) + ' · ' + (num(g.dist, 0) * M_TO_NM).toFixed(1) + ' nm · ' + (err >= 0 ? '↓' : '↑') + fmtInt(Math.abs(err)) + ' ft', color: COL.white });
      const papi = papiState(g, t); if (papi) items.push({ papi });
    }
    if (g.gates && num(g.gates.total, 0) > 0) items.push({ text: 'GATES ' + num(g.gates.passed, 0) + '/' + g.gates.total, color: COL.magenta });
    if (!instr && !items.length) return;
    const fi = font(17 * S, true), iw = instr ? measure(instr, fi) + 28 * S : 0;
    let y = 24 * S;
    const need = Math.max(iw, 300 * S) / 2;
    if (chipsRight > cx - need - 8 || btnLeft < cx + need + 8) y = Math.max(chipsBottom, btnBottom) + 18 * S;
    if (instr) {
      box(cx - iw / 2, y - 14 * S, iw, 28 * S, 8 * S, 'rgba(4,14,20,.62)', 'rgba(255,106,213,.55)');
      text(instr, cx, y + 1, { font: fi, color: COL.white, outline: false });
      y += 28 * S;
    }
    if (!items.length) return;
    const f2 = font(13 * S);
    const ws = items.map((it) => (it.papi ? 30 * S + 4 * 12 * S : measure(it.text, f2)));
    let x = cx - (ws.reduce((a, b) => a + b, 0) + (items.length - 1) * 18 * S) / 2;
    items.forEach((it, i) => {
      if (it.papi) {
        text('PAPI', x, y, { font: font(10 * S, true), align: 'left', color: COL.dim });
        let px = x + 34 * S;
        for (const c of it.papi) { const p = px; fillShape(c === 'W' ? '#ffffff' : COL.red, () => { ctx.moveTo(p + 4 * S, y); ctx.arc(p, y, 4 * S, 0, Math.PI * 2); }); px += 12 * S; }
      } else text(it.text, x, y, { font: f2, align: 'left', color: it.color });
      x += ws[i] + 18 * S;
    });
  }

  // ---------------------------------------------------------------
  // Warnings (2 Hz blink) and terrain look-ahead
  // ---------------------------------------------------------------
  function terrainAhead(s) {
    const gh = FS.world && FS.world.getHeight;
    if (typeof gh !== 'function' || !s.pos || s.airspeed < 15) return false;
    let fx, fz;
    const f = s.forward;
    if (f && Math.hypot(f.x, f.z) > 0.05) { const l = Math.hypot(f.x, f.z); fx = f.x / l; fz = f.z / l; } else { fx = Math.sin(s.heading * D2R); fz = -Math.cos(s.heading * D2R); }
    const x = s.pos.x + fx * 400, z = s.pos.z + fz * 400;
    let h = num(gh(x, z), -Infinity);
    const ot = FS.city && FS.city.getObstacleTop;
    if (typeof ot === 'function') h = Math.max(h, num(ot(x, z), -Infinity));
    return h > s.altitude - 30;
  }
  function drawWarnings(s, v) {
    const inAir = !s.onGround && !s.crashed, list = [];
    const sink = inAir && s.agl < 120 && s.vs < -6;
    if (sink) list.push(['PULL UP', COL.red]);
    else if (inAir && terrainFlag) list.push(['TERRAIN', COL.red]);
    if (inAir && s.stall) list.push(['STALL', COL.red]);
    if (s.airspeed > v.never) list.push(['OVERSPEED', COL.amber]);
    if (inAir && !sink && s.agl < 300 && s.vs < -7.5) list.push(['SINK RATE', COL.amber]);
    if (s.onGround && !s.crashed && s.brakes && s.throttle > 0.3) list.push(['BRAKES', COL.amber]);
    if (!list.length || (now % 0.5) > 0.32) return;
    const shown = list.slice(0, 2), str = shown.map((x) => x[0]).join(' · ');
    const color = shown.some((x) => x[1] === COL.red) ? COL.red : COL.amber;
    const f = font(34 * S, true, 700), w = measure(str, f) + 32 * S, y = H / 2 - 228 * S;
    box(W / 2 - w / 2, y - 22 * S, w, 44 * S, 6 * S, 'rgba(20,4,4,.72)', color);
    text(str, W / 2, y + 2, { font: f, color, outline: false });
  }

  // ---------------------------------------------------------------
  // Mouse-stick reticle / hint
  // ---------------------------------------------------------------
  function drawReticle(s) {
    const m = FS.input && FS.input.mouse, cx = W / 2, cy = H / 2;
    if (s.mouseActive && m) {
      const r = canvas.getBoundingClientRect();
      const mx = num(m.clientX, cx) - r.left, my = num(m.clientY, cy) - r.top;
      const half = Math.max(1, Math.min(W, H) / 2) * 0.85, dz = 0.06 * half;
      line('rgba(143,247,165,.35)', 1, () => { ctx.moveTo(cx, cy); ctx.lineTo(mx, my); });
      line('rgba(200,232,214,.5)', 1, () => { ctx.rect(cx - dz, cy - dz, dz * 2, dz * 2); }, [4, 4]);
      stroke(COL.green, 1.5, () => { ctx.moveTo(cx - 16 * S, cy); ctx.lineTo(cx - 6 * S, cy); ctx.moveTo(cx + 6 * S, cy); ctx.lineTo(cx + 16 * S, cy); ctx.moveTo(cx, cy - 16 * S); ctx.lineTo(cx, cy - 6 * S); ctx.moveTo(cx, cy + 6 * S); ctx.lineTo(cx, cy + 16 * S); });
      stroke(COL.green, 2, () => { ctx.moveTo(mx + 7 * S, my); ctx.arc(mx, my, 7 * S, 0, Math.PI * 2); });
      fillShape(COL.green, () => { ctx.moveTo(mx + 1.5, my); ctx.arc(mx, my, 1.5, 0, Math.PI * 2); }, false);
    } else if (!s.crashed) {
      text('click to fly with the mouse · WASD/arrows also fly · Esc releases', cx, H - 11 * S, { font: font(11 * S), color: 'rgba(200,232,214,.6)' });
    }
  }

  // ---------------------------------------------------------------
  // Frame composer
  // ---------------------------------------------------------------
  function draw(s, g, running, menuOpen) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!running) return;
    const v = vSpeeds();
    if (!FS.settings || FS.settings.hud !== false) {
      drawAttitude(s); drawILS(s, g); drawAirspeed(s, g, v); drawAltitude(s, g); drawHeading(s, g); drawStatus(s); drawSteer(s, g); drawTop(s, g);
    }
    drawWarnings(s, v);
    if (!menuOpen) drawReticle(s);
  }

  // ---------------------------------------------------------------
  // Hotkeys (M, H, K, T), toggles, help flow
  // ---------------------------------------------------------------
  function handleHotkeys() {
    const inp = FS.input;
    if (!inp || !inp.enabled || typeof inp.wasPressed !== 'function') return;
    if (inp.wasPressed('KeyM')) cycleMinimap();
    if (inp.wasPressed('KeyH')) openHelp();
    if (inp.wasPressed('KeyK')) toggleSound();
    if (inp.wasPressed('KeyT')) toggleHud();
  }
  function cycleMinimap() {
    const i = MAP_RANGES.indexOf(mapRange);
    mapRange = MAP_RANGES[(i + 1) % MAP_RANGES.length];
    refreshButtons();
    showMessage(mapRange ? 'MAP ' + (mapRange / 1000) + ' KM' : 'MAP OFF', 1200);
  }
  function toggleSound() {
    const s = FS.settings; if (!s) return;
    s.sound = s.sound === false;
    if (typeof s.save === 'function') s.save(); else applySettings();
    showMessage('SOUND ' + (s.sound ? 'ON' : 'OFF'), 1200);
  }
  function toggleHud() {
    const s = FS.settings; if (!s) return;
    s.hud = s.hud === false;
    if (typeof s.save === 'function') s.save(); else applySettings();
    showMessage('HUD ' + (s.hud ? 'ON' : 'OFF'), 1200);
  }
  function openHelp() {
    const g = FS.game;
    if (g && g.running && typeof g.openMenu === 'function') { helpFromHotkey = true; g.openMenu(); helpFromHotkey = false; }
    else if (menus) menus.showHelp();
  }
  function applySettings() {
    const s = FS.settings || {};
    if (audio) audio.setEnabled(s.sound !== false);
    if (menus) menus.syncSettings();
    refreshButtons();
    domTimer = 1;
  }
  function takeoffAgain(end) {
    const game = FS.game || {}, key = end && end.key;
    const sc = key && Array.isArray(game.scenarios) ? game.scenarios.find((x) => x.kind === 'takeoff' && x.runway === key) : null;
    if (sc && typeof game.start === 'function') { game.start(sc.id); return; }
    const ap = FS.airports, e = (key && ap && ap.getRunwayEnd && ap.getRunwayEnd(key)) || end;
    if (e && e.spawn && FS.aircraft && typeof FS.aircraft.reset === 'function') {
      FS.aircraft.reset({ x: e.spawn.x, z: e.spawn.z, heading: e.spawn.heading, onGround: true, speed: 0, throttle: 0, flaps: 0 });
      if (FS.nav) { if (FS.nav.setTarget) FS.nav.setTarget(e); if (FS.nav.setPhase) FS.nav.setPhase('takeoff'); }
      landed = false;
    } else if (typeof game.restart === 'function') game.restart();
  }

  // ---------------------------------------------------------------
  // Events from the aircraft / nav / game
  // ---------------------------------------------------------------
  function onTouchdown(d) {
    d = d || {};
    if (audio) audio.touchdown(Math.abs(num(d.vs, 0)), num(d.speed, 0));
    if (now - lastReportT < 10 || airborneT < 4) return; // bounce, or never really flew
    lastReportT = now;
    landed = !!d.runwayEnd;
    showLandingReport(d);
    showMessage(d.runwayEnd ? 'LANDED · ' + tgtLabel(d.runwayEnd) : 'LANDED OFF-AIRPORT', 4000, { big: true });
  }
  function bindEvents() {
    const ev = FS.events;
    if (!ev || typeof ev.on !== 'function') return;
    ev.on('touchdown', onTouchdown);
    ev.on('takeoff', () => { landed = false; showMessage('Airborne — climb straight ahead', 2500); });
    ev.on('crash', (d) => { if (audio) audio.crash(); showCrash((d && d.reason) || 'Crashed'); });
    ev.on('reset', () => { landed = false; airborneT = 0; if (menus) { menus.hideCrash(); menus.hideReport(); } });
    ev.on('scenarioStart', (sc) => { landed = false; airborneT = 0; domTimer = 1; if (menus) { menus.hideCrash(); menus.hideReport(); } if (sc && sc.title) showMessage(sc.title, 2200); });
    ev.on('mouseControl', (on) => showMessage('MOUSE STICK ' + (on ? 'ON' : 'OFF'), 1400));
    ev.on('gatePassed', (d) => {
      if (audio) audio.gateChime();
      const g = guidance().gates || {};
      const total = num(d && d.total, num(g.total, 0));
      const passed = Math.max(num(g.passed, 0), num(d && d.index, -1) + 1);
      showMessage('GATE ' + (total ? Math.min(passed, total) + '/' + total : passed), 1500);
    });
    ev.on('cameraMode', () => refreshButtons());
    ev.on('resize', () => resize());
    ev.on('settingsChanged', () => applySettings());
  }

  // ---------------------------------------------------------------
  // Per-frame update and init
  // ---------------------------------------------------------------
  function update(dt) {
    if (!ctx) return;
    try {
      dt = clamp(num(dt, 1 / 60), 0, 0.1);
      now += dt;
      if (window.innerWidth !== lastW || window.innerHeight !== lastH) resize();
      handleHotkeys();
      const s = readState(), g = guidance(), game = FS.game || {};
      const running = !!game.running, paused = !!game.paused, menuOpen = !!(menus && menus.isOpen());
      if (running && !paused) {
        if (s.onGround) airborneT = 0; else { airborneT += dt; if (airborneT > 2) landed = false; }
        terrainT += dt; if (terrainT > 0.1) { terrainT = 0; terrainFlag = terrainAhead(s); }
      }
      const showPaused = running && paused && !menuOpen;
      if (showPaused !== pausedShown) { pausedShown = showPaused; if (menus) menus.setPaused(showPaused); }
      draw(s, g, running, menuOpen);
      domTimer += dt;
      if (domTimer >= 0.25) { domTimer = 0; refreshDom(s, g, running); }
      drawMinimap(s, g, running);
      if (audio) audio.update(dt, { throttle: s.throttle, rpm: Number.isFinite(s.rpm) ? s.rpm : undefined, airspeed: s.airspeed, groundSpeed: s.groundSpeed,
        onGround: s.onGround, stall: s.stall, crashed: s.crashed, running, paused: paused || menuOpen, cameraMode: game.cameraMode, flaps: s.flaps });
    } catch (e) { warnOnce(e); }
  }
  let inited = false;
  function init() {
    if (inited) return; inited = true;
    try {
      const style = el('style'); style.id = 'hud-style'; style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
      buildDom();
      audio = createAudio();
      menus = createMenus({ root, unlockAudio: () => { if (audio) audio.unlock(); }, onSettingsChanged: applySettings, takeoffAgain,
        onHelpClose: () => { const g = FS.game; if (g && g.running && g.closeMenu) g.closeMenu(); else if (menus) menus.hideAll(); } });
      FS.hud.minimapCanvas = mapCanvas;
      FS.hud.audio = audio;
      const unlock = () => { if (audio) audio.unlock(); };
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);
      try { if (document.fonts && document.fonts.load) { document.fonts.load("600 16px 'Barlow Condensed'").catch(() => {}); document.fonts.load("500 16px 'IBM Plex Mono'").catch(() => {}); } } catch (e) { /* fonts optional */ }
      bindEvents();
      resize();
      applySettings();
    } catch (e) { console.warn('[hud] init degraded:', e); }
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  function showStartMenu() { if (menus) menus.showStart(); refreshButtons(); }
  function showMenu() { if (!menus) return; if (helpFromHotkey) { helpFromHotkey = false; menus.showHelp(); } else menus.showMenu(); }
  function hideMenu() { if (menus) menus.hideAll(); }
  function isMenuOpen() { return !!(menus && menus.isOpen()); }
  function showMessage(text, ms, opts) { if (menus) menus.toast(text, ms, opts); }
  function showCrash(reason) { if (menus) menus.showCrash(reason || 'Crashed'); }
  function showLandingReport(data, extra) {
    if (!menus) return;
    const g = guidance().gates || {};
    menus.showLandingReport(data || {}, extra || { gatesPassed: num(g.passed, 0), gatesTotal: num(g.total, 0) });
  }

  FS.hud = { init, update, showStartMenu, showMenu, hideMenu, isMenuOpen, showMessage, showLandingReport, showCrash, minimapCanvas: null,
    cycleMinimap, toggleSound, toggleHud, audio: null };
})();
