/* ============================================================
   Taipei Skies — js/config.js
   Shared constants, geo helpers, seeded noise, input, events,
   settings. Loaded FIRST (right after three.js r128).
   Everything lives on window.FS. Plain script, no modules.
   ============================================================ */
(function () {
  'use strict';
  const FS = (window.FS = window.FS || {});
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // ---------------------------------------------------------------
  // World frame: x = east, z = south (north is -z), y = up, meters.
  // ---------------------------------------------------------------
  const ORIGIN = { lat: 25.05, lon: 121.52 };
  const M_PER_DEG_LAT = 110574;
  const M_PER_DEG_LON = 100845; // 111320 * cos(25.05 deg)

  function toWorld(lat, lon) {
    return { x: (lon - ORIGIN.lon) * M_PER_DEG_LON, z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT };
  }
  function toLatLon(x, z) {
    return { lat: ORIGIN.lat - z / M_PER_DEG_LAT, lon: ORIGIN.lon + x / M_PER_DEG_LON };
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  FS.geo = {
    D2R, R2D, toWorld, toLatLon, clamp, lerp, smoothstep,
    // compass heading (deg, 0 = north, 90 = east) -> unit direction in the x/z plane
    headingToDir(deg) { const r = deg * D2R; return { x: Math.sin(r), z: -Math.cos(r) }; },
    dirToHeading(x, z) { let h = Math.atan2(x, -z) * R2D; if (h < 0) h += 360; return h; },
    // yaw angle (radians, rotation about +Y) that points local -Z along the given heading
    headingToYaw(deg) { return -deg * D2R; },
    wrap360(h) { h %= 360; if (h < 0) h += 360; return h; },
    wrap180(h) { return ((((h + 180) % 360) + 360) % 360) - 180; },
    dist(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); },
    // signed distance of point P from the line through A with unit direction d (+ = right of the line when facing along d)
    crossTrack(px, pz, ax, az, dx, dz) { const rx = px - ax, rz = pz - az; return rx * (-dz) + rz * dx; },
    alongTrack(px, pz, ax, az, dx, dz) { return (px - ax) * dx + (pz - az) * dz; },
  };

  FS.units = { MS_TO_KT: 1.943844, KT_TO_MS: 0.514444, M_TO_FT: 3.28084, FT_TO_M: 0.3048, MS_TO_FPM: 196.8504, M_TO_NM: 1 / 1852 };

  // ---------------------------------------------------------------
  // Geography (authored in lat/lon, converted to world meters here)
  // ---------------------------------------------------------------
  function pts(list) { return list.map(([lat, lon, w]) => Object.assign(toWorld(lat, lon), { lat, lon, w: w || 0 })); }

  const AIRPORTS = [
    {
      icao: 'RCSS', name: 'Taipei Songshan', city: 'Taipei', x: 3277, z: -2145, elev: 5.5,
      // heading = true heading (deg) of the runway when landing on `id`; centerline passes through (cx, cz)
      runways: [{ id: '10', recip: '28', heading: 96, length: 2605, width: 60, cx: 3277, cz: -2145 }],
      terminalSide: 'south', // terminal, apron and tower are south of the runway; military ramp north
    },
    {
      icao: 'RCTP', name: 'Taoyuan International', city: 'Taoyuan', x: -28822, z: -3284, elev: 32,
      runways: [
        { id: '05L', recip: '23R', heading: 50, length: 3660, width: 60, cx: -29273, cz: -3883 },
        { id: '05R', recip: '23L', heading: 50, length: 3800, width: 60, cx: -28371, cz: -2685 },
      ],
      terminalSide: 'between', // terminals sit between the two parallel runways
    },
  ];

  const LANDMARKS = [
    { name: 'Taipei 101', lat: 25.0339, lon: 121.5645, kind: 'tower', height: 508, note: 'Tallest building in Taiwan, 8 stacked pagoda segments + spire' },
    { name: 'Nan Shan Plaza', lat: 25.0365, lon: 121.5665, kind: 'tower', height: 272, note: 'Faceted glass tower beside 101' },
    { name: 'Taipei Nan Shan / Xinyi cluster', lat: 25.0345, lon: 121.5625, kind: 'cluster', height: 120, note: 'Dozens of 60-150 m office towers around 101' },
    { name: 'Shin Kong Life Tower', lat: 25.0460, lon: 121.5150, kind: 'tower', height: 244, note: 'Slender 51-floor tower at Taipei Main Station' },
    { name: 'Taipei Main Station', lat: 25.0478, lon: 121.5170, kind: 'block', height: 30, note: 'Huge 400 x 160 m block with a brown hip roof' },
    { name: 'Presidential Office', lat: 25.0400, lon: 121.5119, kind: 'building', height: 60, note: 'Red-brick colonial building with a 60 m central tower' },
    { name: 'CKS Memorial Hall', lat: 25.0347, lon: 121.5218, kind: 'monument', height: 70, note: 'White hall with a blue octagonal roof in a 500 m park' },
    { name: 'Grand Hotel', lat: 25.0792, lon: 121.5253, kind: 'building', height: 87, note: 'Red-columned palace-style hotel with a hip roof on a hill above the Keelung River' },
    { name: 'Sun Yat-sen Memorial Hall', lat: 25.0400, lon: 121.5600, kind: 'monument', height: 30, note: 'Yellow-roofed hall in a park' },
    { name: 'Taipei Dome', lat: 25.0415, lon: 121.5590, kind: 'dome', height: 65, note: 'Low white-grey dome stadium' },
    { name: 'Taipei Arena', lat: 25.0510, lon: 121.5500, kind: 'dome', height: 35, note: 'Round arena' },
    { name: 'Miramar Ferris Wheel', lat: 25.0830, lon: 121.5570, kind: 'wheel', height: 100, note: '100 m ferris wheel at Dazhi' },
    { name: 'Nangang Exhibition Center', lat: 25.0555, lon: 121.6175, kind: 'block', height: 35, note: 'Large exhibition halls' },
    { name: 'New Taipei City Hall', lat: 25.0125, lon: 121.4655, kind: 'tower', height: 140, note: 'Tallest tower in Banqiao' },
    { name: 'Banqiao Mega Tower', lat: 25.0140, lon: 121.4640, kind: 'tower', height: 200, note: 'Tall tower over Banqiao Station' },
    { name: 'Elephant Mountain', lat: 25.0270, lon: 121.5710, kind: 'terrain', height: 180, note: 'Forested hill overlooking Xinyi' },
    { name: 'Yangmingshan (Qixing)', lat: 25.1700, lon: 121.5450, kind: 'terrain', height: 1120, note: 'Volcanic massif north of the city' },
    { name: 'Guanyin Mountain', lat: 25.1320, lon: 121.4180, kind: 'terrain', height: 616, note: 'Mountain across the Tamsui River' },
    { name: 'Tamsui', lat: 25.1680, lon: 121.4400, kind: 'town', height: 0, note: 'River-mouth town' },
  ].map((l) => Object.assign(l, toWorld(l.lat, l.lon)));

  // Rivers: polylines, each point [lat, lon, width_m]. Drawn on the ground and cut into the heightmap (water at y=0).
  const RIVERS = [
    { name: 'Tamsui River', points: pts([
      [25.028, 121.473, 400], [25.040, 121.478, 450], [25.050, 121.492, 450], [25.059, 121.504, 450], [25.070, 121.500, 450],
      [25.085, 121.492, 500], [25.100, 121.478, 550], [25.114, 121.463, 600], [25.125, 121.452, 700], [25.145, 121.440, 800],
      [25.165, 121.428, 900], [25.180, 121.412, 1100], [25.195, 121.395, 1500], [25.215, 121.375, 2200],
    ]) },
    { name: 'Keelung River', points: pts([
      [25.067, 121.662, 110], [25.070, 121.645, 120], [25.062, 121.628, 130], [25.056, 121.612, 140], [25.053, 121.596, 150],
      [25.052, 121.580, 160], [25.057, 121.574, 160], [25.064, 121.573, 170], [25.072, 121.570, 170], [25.079, 121.562, 175], [25.081, 121.550, 180],
      [25.079, 121.535, 180], [25.077, 121.522, 190], [25.082, 121.510, 190], [25.092, 121.500, 200], [25.103, 121.487, 210],
      [25.110, 121.472, 220], [25.114, 121.463, 230],
    ]) },
    { name: 'Xindian River', points: pts([
      [24.930, 121.545, 180], [24.945, 121.538, 200], [24.965, 121.535, 220], [24.985, 121.535, 250], [25.005, 121.530, 280],
      [25.015, 121.520, 300], [25.025, 121.505, 330], [25.030, 121.490, 360], [25.028, 121.475, 400],
    ]) },
    { name: 'Dahan River', points: pts([
      [24.900, 121.330, 220], [24.930, 121.360, 250], [24.950, 121.385, 300], [24.970, 121.410, 350], [24.985, 121.430, 400],
      [25.000, 121.445, 450], [25.015, 121.460, 450], [25.028, 121.473, 400],
    ]) },
  ];

  // Coastline from NE to SW. The SEA is on the LEFT-hand side of this line when walking it (north / west).
  const COAST = pts([
    [25.20, 121.95], [25.16, 121.78], [25.23, 121.66], [25.29, 121.56], [25.26, 121.49], [25.20, 121.43], [25.185, 121.405],
    [25.165, 121.400], [25.13, 121.35], [25.115, 121.30], [25.108, 121.25], [25.100, 121.22], [25.080, 121.18], [25.040, 121.10], [24.98, 121.00],
  ]);

  // Mountain massifs (guides for the heightmap; the world module adds noise, ridges and valleys on top)
  const MOUNTAINS = [
    { name: 'Qixing (Yangmingshan)', lat: 25.170, lon: 121.545, height: 1120, radius: 5000, kind: 'peak' },
    { name: 'Datun', lat: 25.176, lon: 121.522, height: 1092, radius: 4500, kind: 'peak' },
    { name: 'Miantian', lat: 25.190, lon: 121.490, height: 1000, radius: 4000, kind: 'peak' },
    { name: 'Wuzhi', lat: 25.150, lon: 121.600, height: 900, radius: 4000, kind: 'peak' },
    { name: 'Guanyin', lat: 25.132, lon: 121.418, height: 616, radius: 3200, kind: 'peak' },
    { name: 'Linkou plateau', lat: 25.080, lon: 121.360, height: 250, radius: 8000, kind: 'plateau' },
    { name: 'Neihu hills', lat: 25.100, lon: 121.590, height: 500, radius: 2500, kind: 'peak' },
    { name: 'Nangang range', lat: 25.020, lon: 121.630, height: 500, radius: 4000, kind: 'ridge' },
    { name: 'Elephant Mountain', lat: 25.025, lon: 121.575, height: 200, radius: 1200, kind: 'peak' },
    { name: 'Muzha hills', lat: 24.985, lon: 121.575, height: 350, radius: 3500, kind: 'ridge' },
    { name: 'Ankeng hills', lat: 24.950, lon: 121.500, height: 400, radius: 4000, kind: 'ridge' },
    { name: 'Tucheng hills', lat: 24.960, lon: 121.420, height: 350, radius: 3500, kind: 'ridge' },
    { name: 'Guishan hills', lat: 25.000, lon: 121.330, height: 300, radius: 6000, kind: 'plateau' },
    { name: 'Wulai massif', lat: 24.850, lon: 121.550, height: 1200, radius: 10000, kind: 'peak' },
    { name: 'Sanxia massif', lat: 24.880, lon: 121.400, height: 900, radius: 8000, kind: 'peak' },
    { name: 'Pingxi hills', lat: 25.030, lon: 121.720, height: 700, radius: 8000, kind: 'ridge' },
    { name: 'Keelung hills', lat: 25.120, lon: 121.720, height: 500, radius: 6000, kind: 'ridge' },
  ].map((m) => Object.assign(m, toWorld(m.lat, m.lon)));

  // Parks / green campuses (w, h in meters; axis-aligned unless rot given in deg)
  const PARKS = [
    { name: 'Daan Forest Park', lat: 25.0300, lon: 121.5360, w: 500, h: 450 },
    { name: 'NTU campus', lat: 25.0175, lon: 121.5390, w: 900, h: 700, campus: true },
    { name: 'Youth Park', lat: 25.0225, lon: 121.5030, w: 400, h: 350 },
    { name: 'Botanical Garden', lat: 25.0318, lon: 121.5100, w: 250, h: 250 },
    { name: 'CKS Memorial Park', lat: 25.0347, lon: 121.5218, w: 500, h: 450 },
    { name: 'Sun Yat-sen Memorial Park', lat: 25.0400, lon: 121.5600, w: 400, h: 350 },
    { name: 'Taipei Expo Park', lat: 25.0700, lon: 121.5230, w: 900, h: 350 },
    { name: 'Taipei Zoo', lat: 25.0000, lon: 121.5800, w: 1200, h: 900 },
  ].map((p) => Object.assign(p, toWorld(p.lat, p.lon)));

  // High-rise clusters (CBDs): radius in m, typical tower heights (m), density 0..1
  const CBDS = [
    { name: 'Xinyi', lat: 25.035, lon: 121.565, radius: 900, minH: 60, maxH: 160, density: 0.9 },
    { name: 'Taipei Main Station', lat: 25.047, lon: 121.517, radius: 600, minH: 50, maxH: 130, density: 0.7 },
    { name: 'Nanjing-Dunhua', lat: 25.052, lon: 121.545, radius: 900, minH: 40, maxH: 100, density: 0.5 },
    { name: 'Neihu Tech Park', lat: 25.078, lon: 121.575, radius: 900, minH: 40, maxH: 90, density: 0.6 },
    { name: 'Nangang Software Park', lat: 25.057, lon: 121.615, radius: 700, minH: 40, maxH: 110, density: 0.6 },
    { name: 'Dazhi', lat: 25.082, lon: 121.557, radius: 600, minH: 40, maxH: 90, density: 0.5 },
    { name: 'Banqiao', lat: 25.013, lon: 121.465, radius: 800, minH: 50, maxH: 140, density: 0.7 },
    { name: 'Sanchong', lat: 25.065, lon: 121.490, radius: 500, minH: 40, maxH: 80, density: 0.4 },
    { name: 'Xinzhuang Fuduxin', lat: 25.040, lon: 121.440, radius: 700, minH: 40, maxH: 100, density: 0.5 },
    { name: 'Zhongshan N Rd', lat: 25.060, lon: 121.523, radius: 500, minH: 40, maxH: 90, density: 0.4 },
  ].map((c) => Object.assign(c, toWorld(c.lat, c.lon)));

  FS.CONFIG = {
    origin: ORIGIN, mPerDegLat: M_PER_DEG_LAT, mPerDegLon: M_PER_DEG_LON,
    worldHalfSize: 36000,                       // outer terrain covers [-36 km, +36 km] in x and z
    innerRect: { x0: -14000, x1: 14000, z0: -15000, z1: 13000 }, // high-detail terrain + ground texture
    seaLevel: 0,
    gravity: 9.81,
    rho: 1.225,
    // Sun: azimuth = compass direction the sun sits in (235 = SW), elevation above horizon. Late afternoon light.
    sun: { azimuthDeg: 235, elevationDeg: 34 },
    // Wind: from direction (deg) and speed (m/s). Light headwind for RCSS runway 10 (the default scenario);
    // both runway ends stay usable. Modules may ignore wind.
    wind: { fromDeg: 100, speed: 2.0 },
    airports: AIRPORTS, landmarks: LANDMARKS, rivers: RIVERS, coast: COAST, mountains: MOUNTAINS, parks: PARKS, cbds: CBDS,
    // Dense urban footprint: the flat basin floor. Everything below ~40 m elevation inside the inner rect and within
    // ~13 km of (0, 1000) is city; hillsides taper off by ~120 m elevation.
    urbanCenter: { x: 0, z: 1000, radius: 13000 },
  };

  // ---------------------------------------------------------------
  // Colors / textures. Renderer uses sRGB output + ACES tone mapping,
  // so material colors must be linear: always build colors with FS.color().
  // ---------------------------------------------------------------
  FS.color = function (hex) { return new THREE.Color(hex).convertSRGBToLinear(); };
  FS.textureFromCanvas = function (canvas, opts) {
    opts = opts || {};
    const tex = new THREE.CanvasTexture(canvas);
    tex.encoding = opts.linear ? THREE.LinearEncoding : THREE.sRGBEncoding;
    tex.wrapS = tex.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    const maxAniso = FS.renderer ? FS.renderer.capabilities.getMaxAnisotropy() : 1;
    tex.anisotropy = Math.min(opts.anisotropy || 8, maxAniso);
    tex.needsUpdate = true;
    return tex;
  };

  // ---------------------------------------------------------------
  // Seeded random + 2D simplex noise (shared so all modules agree)
  // ---------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeNoise(seed) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256), perm = new Uint8Array(512);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const gx = [1, -1, 1, -1, 1, -1, 0, 0], gy = [1, 1, -1, -1, 0, 0, 1, -1];
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    function noise2(xin, yin) {
      const s = (xin + yin) * F2;
      const i = Math.floor(xin + s), j = Math.floor(yin + s);
      const t = (i + j) * G2;
      const x0 = xin - (i - t), y0 = yin - (j - t);
      const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      const g0 = perm[ii + perm[jj]] & 7, g1 = perm[ii + i1 + perm[jj + j1]] & 7, g2 = perm[ii + 1 + perm[jj + 1]] & 7;
      let n = 0, t0 = 0.5 - x0 * x0 - y0 * y0, t1 = 0.5 - x1 * x1 - y1 * y1, t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t0 > 0) { t0 *= t0; n += t0 * t0 * (gx[g0] * x0 + gy[g0] * y0); }
      if (t1 > 0) { t1 *= t1; n += t1 * t1 * (gx[g1] * x1 + gy[g1] * y1); }
      if (t2 > 0) { t2 *= t2; n += t2 * t2 * (gx[g2] * x2 + gy[g2] * y2); }
      return 70 * n; // [-1, 1]
    }
    function fbm(x, y, octaves, lacunarity, gain) {
      octaves = octaves || 4; lacunarity = lacunarity || 2; gain = gain || 0.5;
      let a = 1, f = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) { sum += a * noise2(x * f, y * f); norm += a; a *= gain; f *= lacunarity; }
      return sum / norm;
    }
    function ridged(x, y, octaves, lacunarity, gain) {
      octaves = octaves || 4; lacunarity = lacunarity || 2; gain = gain || 0.5;
      let a = 1, f = 1, sum = 0, norm = 0;
      for (let o = 0; o < octaves; o++) { sum += a * (1 - Math.abs(noise2(x * f, y * f))); norm += a; a *= gain; f *= lacunarity; }
      return sum / norm; // [0, 1]
    }
    return { noise2, fbm, ridged, rand };
  }
  FS.mulberry32 = mulberry32;
  FS.makeNoise = makeNoise;
  FS.noise = makeNoise(20260926);

  // ---------------------------------------------------------------
  // Events: 'touchdown' {vs, speed, x, z, runwayEnd, crossTrack, alongFromThreshold, hard}
  //         'takeoff' {runwayEnd|null}, 'crash' {reason}, 'reset' {}, 'scenarioStart' {scenario},
  //         'mouseControl' bool, 'gatePassed' {index, total}, 'settingsChanged' {}
  // ---------------------------------------------------------------
  FS.events = {
    _l: new Map(),
    on(name, fn) { if (!this._l.has(name)) this._l.set(name, new Set()); this._l.get(name).add(fn); return () => this.off(name, fn); },
    off(name, fn) { const s = this._l.get(name); if (s) s.delete(fn); },
    emit(name, data) {
      const s = this._l.get(name); if (!s) return;
      for (const fn of Array.from(s)) { try { fn(data); } catch (e) { console.error('[events:' + name + ']', e); } }
    },
  };

  // ---------------------------------------------------------------
  // Settings (persisted per viewer; every read/write is guarded)
  // ---------------------------------------------------------------
  const DEFAULTS = {
    mouseSensitivity: 1.0, invertMouseY: false, invertKeyPitch: false,
    quality: 'medium',           // 'low' | 'medium' | 'high'
    shadows: true, sound: true, cameraMode: 'chase', guidance: true, hud: true, showFps: false,
  };
  FS.settings = Object.assign({}, DEFAULTS);
  FS.settings.defaults = DEFAULTS;
  FS.settings.load = function () {
    try {
      const raw = localStorage.getItem('taipei-skies-settings');
      if (!raw) return;
      const o = JSON.parse(raw);
      for (const k of Object.keys(DEFAULTS)) if (k in o) FS.settings[k] = o[k];
    } catch (e) { /* storage unavailable */ }
  };
  FS.settings.save = function () {
    try {
      const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = FS.settings[k];
      localStorage.setItem('taipei-skies-settings', JSON.stringify(o));
    } catch (e) { /* storage unavailable */ }
    FS.events.emit('settingsChanged', {});
  };

  // ---------------------------------------------------------------
  // Input: keyboard by event.code, mouse "virtual stick" and wheel.
  //   FS.input.isDown('KeyW')            held
  //   FS.input.wasPressed('KeyC')        pressed this frame (cleared by main at frame end)
  //   FS.input.axis(['KeyA'], ['KeyD'])  -1 / 0 / +1
  //   FS.input.mouse {active, x, y}      x,y in [-1,1]: deflection of the cursor from the canvas center
  //                                      (+x = cursor right of center, +y = cursor BELOW center)
  //   FS.input.wheel                     accumulated deltaY since last frame (+ = wheel down)
  // Mouse control engages when the canvas is left-clicked, releases on Esc / X / right-click.
  // ---------------------------------------------------------------
  const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'PageUp', 'PageDown']);
  FS.input = {
    keys: new Set(), pressed: new Set(),
    mouse: { active: false, x: 0, y: 0, clientX: 0, clientY: 0, overCanvas: false },
    wheel: 0,
    enabled: true, // main sets false while a menu is open; hotkeys are still tracked
    canvas: null,
    isDown() { for (let i = 0; i < arguments.length; i++) if (this.keys.has(arguments[i])) return true; return false; },
    wasPressed(code) { return this.pressed.has(code); },
    axis(neg, pos) { return (this.isDown.apply(this, pos) ? 1 : 0) - (this.isDown.apply(this, neg) ? 1 : 0); },
    setMouseActive(on) {
      on = !!on;
      if (on === this.mouse.active) return;
      this.mouse.active = on;
      if (!on) { this.mouse.x = 0; this.mouse.y = 0; }
      if (this.canvas) this.canvas.style.cursor = on ? 'none' : 'crosshair';
      FS.events.emit('mouseControl', on);
    },
    endFrame() { this.pressed.clear(); this.wheel = 0; },
    bind(canvas) {
      this.canvas = canvas;
      const self = this;
      const isTyping = (e) => { const t = e.target; return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)); };
      window.addEventListener('keydown', (e) => {
        if (isTyping(e)) return;
        if (!e.repeat) self.pressed.add(e.code);
        self.keys.add(e.code);
        if (e.code === 'Escape' || e.code === 'KeyX') self.setMouseActive(false);
        if (GAME_KEYS.has(e.code) && self.enabled) e.preventDefault();
      });
      window.addEventListener('keyup', (e) => { self.keys.delete(e.code); });
      window.addEventListener('blur', () => { self.keys.clear(); });
      const updateMouse = (e) => {
        const r = canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const half = Math.max(1, Math.min(r.width, r.height) / 2) * 0.85;
        self.mouse.clientX = e.clientX; self.mouse.clientY = e.clientY;
        if (self.mouse.active) {
          self.mouse.x = clamp((e.clientX - cx) / half, -1, 1);
          self.mouse.y = clamp((e.clientY - cy) / half, -1, 1);
        }
      };
      window.addEventListener('mousemove', updateMouse);
      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) { if (self.enabled && !self.mouse.active) { self.setMouseActive(true); updateMouse(e); } }
        else if (e.button === 2) self.setMouseActive(false);
      });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('wheel', (e) => { if (!self.enabled) return; self.wheel += e.deltaY; e.preventDefault(); }, { passive: false });
      canvas.addEventListener('mouseenter', () => { self.mouse.overCanvas = true; });
      canvas.addEventListener('mouseleave', () => { self.mouse.overCanvas = false; });
    },
  };
})();
