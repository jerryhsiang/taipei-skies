/* ============================================================
   Taipei Skies — js/airports.js
   Taipei Songshan (RCSS) and Taoyuan International (RCTP):
   runway meshes with painted ICAO markings, taxiways, aprons,
   terminals, control towers, hangars, parked airliners, runway /
   taxiway / approach lights (THREE.Points), PAPI, beacons, windsocks.
   Exports FS.airports (CONTRACT.md):
     init(scene), list, getRunwayEnds(), getRunwayEnd(key),
     isOnRunway(x, z), isOnPaved(x, z), nearest(x, z), update(dt, state)
   Additions to the contract:
     end.papiState   'WWRR'-style string (outermost light first), refreshed by update()
     end.runway      non-enumerable back-reference {id, recip, heading, center, dir, right, length, width, ends}
     airport.frame   runway-1 frame helper ({origin, dir, right, p(s,t)}) used for the layouts
   Draw calls: 3 runways + per airport (buildings, glass, airliners, taxiways,
   aprons, taxi lines, static lights, dynamic lights) = 19 total.
   ============================================================ */
(function () {
  'use strict';
  const FS = window.FS || (window.FS = {});
  const G = FS.geo;
  const CFG = FS.CONFIG;
  const D2R = Math.PI / 180;
  const V3 = THREE.Vector3;
  const UP = new V3(0, 1, 0);
  const rand = FS.mulberry32 ? FS.mulberry32(9026) : Math.random;

  // ---------------------------------------------------------------
  // Runway frame: s = meters along `dir` from the id-end threshold,
  // t = meters to the RIGHT of dir (facing along it). x east, z south.
  // ---------------------------------------------------------------
  function makeFrame(origin, dir, elev) {
    const right = { x: -dir.z, z: dir.x };
    const F = {
      origin, dir, right, elev,
      // rotation about +Y that maps local +X -> dir and local +Z -> right
      yaw: Math.atan2(-dir.z, dir.x),
      p(s, t) { return { x: origin.x + dir.x * s + right.x * t, z: origin.z + dir.z * s + right.z * t }; },
      st(x, z) { const rx = x - origin.x, rz = z - origin.z; return { s: rx * dir.x + rz * dir.z, t: rx * right.x + rz * right.z }; },
      // rotated rectangle covering s0..s1 (along) and t0..t1 (across)
      rect(s0, s1, t0, t1, kind) {
        const c = F.p((s0 + s1) / 2, (t0 + t1) / 2);
        return { cx: c.x, cz: c.z, dir, right, along: s1 - s0, across: t1 - t0, s0, s1, t0, t1, kind: kind || 'paved', frame: F };
      },
    };
    return F;
  }
  function inRect(r, x, z, margin) {
    margin = margin || 0;
    const rx = x - r.cx, rz = z - r.cz;
    const a = rx * r.dir.x + rz * r.dir.z, b = rx * r.right.x + rz * r.right.z;
    return Math.abs(a) <= r.along / 2 + margin && Math.abs(b) <= r.across / 2 + margin;
  }
  // placement matrix for geometry authored in frame-local space (x along s, z along t, y up from the apron)
  function place(F, s, t, y, extraYaw) {
    const p = F.p(s, t);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, F.yaw + (extraYaw || 0));
    return new THREE.Matrix4().compose(new V3(p.x, F.elev + y, p.z), q, new V3(1, 1, 1));
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function groundY(x, z, elev) {
    const w = FS.world;
    if (w && typeof w.getHeight === 'function') { const h = w.getHeight(x, z); if (isFinite(h)) return h; }
    return elev;
  }

  // ---------------------------------------------------------------
  // Merger: accumulates geometry with per-vertex colors -> ONE mesh
  // ---------------------------------------------------------------
  function Merger() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.count = 0; }
  Merger.prototype.add = function (geo, matrix, hex) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    const c = FS.color(hex);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    this.count += p.count;
    g.dispose(); geo.dispose();
  };
  // flat quad from 4 world corners (counter-clockwise seen from above), normal up; uv given per corner
  Merger.prototype.quad = function (a, b, c, d, y, hex, uvs) {
    const col = FS.color(hex);
    const pts = [a, b, c, d], order = [0, 2, 1, 0, 3, 2];
    uvs = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const i of order) {
      this.pos.push(pts[i].x, y, pts[i].z); this.nor.push(0, 1, 0); this.col.push(col.r, col.g, col.b); this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.count += 6;
  };
  // flat rotated rect (frame.rect) with uvs in frame meters / scale
  Merger.prototype.rect = function (r, y, hex, uvScale) {
    const F = r.frame, k = 1 / (uvScale || 10);
    const c = [F.p(r.s0, r.t0), F.p(r.s1, r.t0), F.p(r.s1, r.t1), F.p(r.s0, r.t1)];
    this.quad(c[0], c[1], c[2], c[3], y, hex, [[r.s0 * k, r.t0 * k], [r.s1 * k, r.t0 * k], [r.s1 * k, r.t1 * k], [r.s0 * k, r.t1 * k]]);
  };
  // thin strip between two world points (taxiway centerlines)
  Merger.prototype.strip = function (a, b, w, y, hex) {
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * w / 2, nz = dx / len * w / 2;
    this.quad({ x: a.x - nx, z: a.z - nz }, { x: b.x - nx, z: b.z - nz }, { x: b.x + nx, z: b.z + nz }, { x: a.x + nx, z: a.z + nz }, y, hex);
  };
  Merger.prototype.build = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  };
  Merger.prototype.mesh = function (material, cast, receive) {
    if (this.count === 0) return null;
    const m = new THREE.Mesh(this.build(), material);
    m.castShadow = !!cast; m.receiveShadow = !!receive;
    return m;
  };

  // ---------------------------------------------------------------
  // Lights: THREE.Points, per-vertex color, direction (0 = omni) and size factor.
  // PointsMaterial + onBeforeCompile keeps the log-depth / tone-mapping chunks intact.
  // ---------------------------------------------------------------
  function LightSet() { this.pos = []; this.col = []; this.dir = []; this.size = []; this.n = 0; }
  LightSet.prototype.add = function (x, y, z, hex, size, dx, dz, gain) {
    const c = FS.color(hex); gain = gain || 1;
    this.pos.push(x, y, z); this.col.push(c.r * gain, c.g * gain, c.b * gain);
    this.dir.push(dx || 0, 0, dz || 0); this.size.push(size || 1);
    return this.n++;
  };
  LightSet.prototype.points = function (material, dynamic) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    const col = new THREE.Float32BufferAttribute(this.col, 3);
    if (dynamic) col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', col);
    g.setAttribute('ldir', new THREE.Float32BufferAttribute(this.dir, 3));
    g.setAttribute('lsize', new THREE.Float32BufferAttribute(this.size, 1));
    g.computeBoundingSphere();
    const p = new THREE.Points(g, material);
    p.frustumCulled = false;
    return p;
  };
  function glowTexture() {
    const c = canvas(64, 64), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.16, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    return FS.textureFromCanvas(c, { linear: true });
  }
  function lightMaterial() {
    const mat = new THREE.PointsMaterial({
      size: 3.2, map: glowTexture(), vertexColors: true, sizeAttenuation: true,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    // NOTE: r128 never uploads `cameraPosition` for PointsMaterial programs (WebGLRenderer.setProgram only does it for
    // ShaderMaterial / Phong / Toon / Standard / envMap), so the view vector is taken from modelViewMatrix instead.
    mat.onBeforeCompile = function (shader) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 ldir;\nattribute float lsize;\nvarying float vFade;')
        .replace('void main() {', 'void main() {\n' +
          '  vec3 lmv = (modelViewMatrix * vec4(position, 1.0)).xyz;\n' +
          '  float ldist = max(length(lmv), 1.0);\n' +
          '  vec3 ldirView = mat3(modelViewMatrix) * ldir;\n' +
          '  float lfd = dot(ldir, ldir) < 0.5 ? 1.0 : smoothstep(-0.35, 0.25, dot(normalize(ldirView), -lmv / ldist));\n' +
          '  vFade = lfd * clamp(1.4 - ldist / 30000.0, 0.0, 1.0);')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * lsize;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', 'gl_FragColor = vec4( outgoingLight * vFade, diffuseColor.a * vFade );');
    };
    return mat;
  }

  // ---------------------------------------------------------------
  // Runway texture. Canvas convention (proof in buildRunwayMesh):
  //   canvas x  = across the runway, u in meters, u < 0 is the LEFT of a pilot landing on rw.id
  //   canvas y  = along the runway, BOTTOM row = threshold of rw.id (v = 0), TOP row = threshold of rw.recip (v = L)
  // The plane is 12 m wider than the runway: 6 m lighter shoulders on each side.
  // ---------------------------------------------------------------
  const SHOULDER = 6;
  function paintRunwayCanvas(rw, cw, ch) {
    const L = rw.length, W = rw.width, Wc = W + 2 * SHOULDER;
    const sx = cw / Wc, sy = ch / L;
    const c = canvas(cw, ch), ctx = c.getContext('2d');
    // meter frame: (u, v) -> pixels, v increasing UP the canvas (this transform mirrors, so it is only used for rects)
    const M = () => ctx.setTransform(sx, 0, 0, -sy, cw / 2, ch);
    const R = (u0, v0, w, h) => ctx.fillRect(u0, v0, w, h);
    M();
    ctx.fillStyle = '#5a5b57'; R(-Wc / 2, 0, Wc, L);           // shoulders
    ctx.fillStyle = '#3a3b3a'; R(-W / 2, 0, W, L);             // asphalt
    for (let i = 0; i < 36; i++) {                             // repaved patches / tonal bands
      ctx.fillStyle = rand() < 0.5 ? '#000' : '#fff'; ctx.globalAlpha = 0.02 + rand() * 0.035;
      R(-W / 2, rand() * L, W, 60 + rand() * 260);
    }
    for (let i = 0; i < 800; i++) {                            // longitudinal streaks
      ctx.fillStyle = rand() < 0.55 ? '#000' : '#fff'; ctx.globalAlpha = 0.03 + rand() * 0.05;
      R(-W / 2 + rand() * W, rand() * L, 0.3 + rand() * 1.4, 15 + rand() * 180);
    }
    ctx.globalAlpha = 1;

    // markings for one end. flip=false: measured from the id threshold (canvas bottom); flip=true: from the recip end.
    const markings = (flip, label) => {
      const RV = (u0, d0, w, len) => R(u0, flip ? L - d0 - len : d0, w, len); // rect from d0 to d0+len from this threshold
      ctx.fillStyle = '#ececec';
      for (let i = 0; i < 16; i++) RV(-27 + i * 3.375 + (3.375 - 1.8) / 2, 6, 1.8, 30);   // threshold piano keys
      RV(-18, 300, 9, 45); RV(9, 300, 9, 45);                                             // aiming point bars
      const tdz = [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]];                       // touchdown-zone pairs
      for (const [d, n] of tdz) for (let k = 0; k < n; k++) { const off = 9 + k * 3.3; RV(-off - 1.8, d, 1.8, 22.5); RV(off, d, 1.8, 22.5); }
      // designation: letter (parallel runways) nearer the threshold, then the number. Text uses a uniform meter scale
      // with NO mirroring: upright in canvas space for the id end, rotated 180 deg for the recip end, so the pilot
      // landing on that end (whose right hand is canvas-right for id / canvas-left for recip) reads it upright.
      const m = /^(\d+)([LCR]?)$/.exec(label) || [label, label, ''];
      const text = (txt, dCenter, em) => {
        const py = flip ? dCenter * sy : ch - dCenter * sy;
        ctx.setTransform(sx, 0, 0, sy, cw / 2, py);
        if (flip) ctx.rotate(Math.PI);
        ctx.font = 'bold ' + em + 'px "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, 0, 0);
        M();
      };
      if (m[2]) { text(m[2], 53, 12.5); text(m[1], 68, 12.5); } else text(m[1], 54, 12.5);
    };
    markings(false, rw.id);
    markings(true, rw.recip);
    // centerline 30 m stripes / 20 m gaps, 0.9 m wide, and edge stripes
    ctx.fillStyle = '#ececec';
    const v0 = 86, v1 = L - 86;
    for (let v = v0 + ((v1 - v0) % 50) / 2; v + 30 <= v1 + 0.01; v += 50) R(-0.45, v, 0.9, 30);
    R(-W / 2, 0, 0.9, L); R(W / 2 - 0.9, 0, 0.9, L);
    // tire rubber over both touchdown zones (drawn last: rubber covers paint)
    for (const flip of [false, true]) for (let i = 0; i < 360; i++) {
      const d = 60 + Math.pow(rand(), 1.5) * 720, side = rand() < 0.5 ? -1 : 1;
      const u = side * (rand() < 0.15 ? rand() * 1.5 : 2.5 + rand() * 5.5);
      const len = 8 + rand() * 60, w = 0.8 + rand() * 1.8;
      ctx.globalAlpha = (0.05 + rand() * 0.22) * (1 - d / 820);
      ctx.fillStyle = '#0e0e0e';
      R(u - w / 2, flip ? L - d - len : d, w, len);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  function buildRunwayMesh(rw, elev) {
    const maxT = FS.renderer && FS.renderer.capabilities ? FS.renderer.capabilities.maxTextureSize : 4096;
    const ch = maxT >= 8192 ? 8192 : 4096, cw = ch >= 8192 ? 256 : 512;
    const tex = FS.textureFromCanvas(paintRunwayCanvas(rw, cw, ch), { anisotropy: 8 });
    // ORIENTATION PROOF. PlaneGeometry(Wc, L) lies in local XY: uv (0,0) at (-Wc/2, -L/2), uv.y = 1 along +Y.
    // A CanvasTexture (flipY = true) puts the canvas TOP row at uv.y = 1 -> local +Y, canvas BOTTOM at local -Y,
    // canvas RIGHT at local +X. geometry.rotateX(-90deg) maps local +Y -> -Z (normal -> +Y, faces up), +X stays +X.
    // mesh.rotation.y = headingToYaw(H) rotates local -Z onto headingToDir(H) and local +X onto the right of it.
    // With H = heading of rw.id: canvas TOP = far end along dir(id) = threshold of rw.recip, canvas BOTTOM = threshold
    // of rw.id, canvas RIGHT = the right hand of a pilot landing on rw.id. paintRunwayCanvas uses this convention.
    const geo = new THREE.PlaneGeometry(rw.width + 2 * SHOULDER, rw.length);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, color: FS.color('#ffffff'), roughness: 0.9, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(rw.center.x, elev + 0.15, rw.center.z);
    m.rotation.y = G.headingToYaw(rw.heading);
    m.receiveShadow = true;
    m.name = 'runway-' + rw.id;
    return m;
  }

  // small repeating tiles for aprons (concrete slabs) and taxiways (asphalt)
  function apronTexture() {
    const c = canvas(256, 256), ctx = c.getContext('2d');
    ctx.fillStyle = '#8a8a86'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1400; i++) { ctx.fillStyle = rand() < 0.5 ? '#000' : '#fff'; ctx.globalAlpha = 0.03 + rand() * 0.05; ctx.fillRect(rand() * 256, rand() * 256, 1 + rand() * 3, 1 + rand() * 3); }
    ctx.globalAlpha = 0.35; ctx.fillStyle = '#5c5c58';
    for (let i = 0; i < 4; i++) { ctx.fillRect(i * 64, 0, 1.5, 256); ctx.fillRect(0, i * 64, 256, 1.5); } // slab joints (tile = 30 m -> 7.5 m slabs)
    ctx.globalAlpha = 1;
    const t = FS.textureFromCanvas(c, { repeat: true, anisotropy: 4 }); return t;
  }
  function taxiwayTexture() {
    const c = canvas(256, 256), ctx = c.getContext('2d');
    ctx.fillStyle = '#6f6f6c'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) { ctx.fillStyle = rand() < 0.5 ? '#000' : '#fff'; ctx.globalAlpha = 0.03 + rand() * 0.05; ctx.fillRect(rand() * 256, rand() * 256, 1 + rand() * 2, 4 + rand() * 30); }
    ctx.globalAlpha = 1;
    return FS.textureFromCanvas(c, { repeat: true, anisotropy: 4 });
  }

  // ---------------------------------------------------------------
  // Building / prop builders. All geometry is authored in frame-local
  // space (x along s, z along t, y up from the apron) and merged.
  // ---------------------------------------------------------------
  function box(m, F, s, t, w, h, d, hex, y0, yaw) {
    m.add(new THREE.BoxGeometry(w, h, d), place(F, s, t, (y0 || 0) + h / 2, yaw), hex);
  }
  function cyl(m, F, s, t, r, h, hex, y0, seg) {
    m.add(new THREE.CylinderGeometry(r, r, h, seg || 16), place(F, s, t, (y0 || 0) + h / 2), hex);
  }
  // hangar / terminal with an arched roof: walls (len along s, wid along t), half-cylinder roof squashed to archH
  function hangar(m, F, s, t, len, wid, wallH, archH, hex, roofHex) {
    box(m, F, s, t, len, wallH, wid, hex);
    const arch = new THREE.CylinderGeometry(wid / 2, wid / 2, len, 22, 1, false, 0, Math.PI);
    arch.rotateZ(Math.PI / 2);                 // axis along local X (= s), arc on the +Y side
    arch.scale(1, archH / (wid / 2), 1);
    arch.translate(0, wallH, 0);
    m.add(arch, place(F, s, t, 0), roofHex || hex);
  }
  // terminal block with a recessed glass front along one long side (side = +1: the +t face, -1: the -t face)
  function terminalBlock(m, glass, F, s, t, len, dep, h, hex, sides) {
    box(m, F, s, t, len, h, dep, hex);
    box(m, F, s, t, len + 2, 1.2, dep + 2, '#9a9a96', h);                 // roof slab / parapet
    for (const side of sides || [1]) {
      const gt = t + side * (dep / 2 + 0.6);
      glass.add(new THREE.BoxGeometry(len - 6, h - 5, 1.0), place(F, s, gt, 2.5 + (h - 5) / 2), '#3d6480');
    }
  }
  // control tower: slender shaft, wider glazed cab on top; returns the viewpoint (m MSL)
  function tower(m, glass, F, s, t, shaftH, r, hex) {
    cyl(m, F, s, t, r, shaftH, hex, 0, 18);
    cyl(m, F, s, t, r * 1.4, 2, '#c8c8c4', shaftH - 2, 18);              // service floor
    glass.add(new THREE.CylinderGeometry(r * 2, r * 1.7, 5.5, 18, 1, true), place(F, s, t, shaftH + 2.75), '#2b4658');
    m.add(new THREE.CylinderGeometry(r * 2.15, r * 2.15, 1.2, 18), place(F, s, t, shaftH + 6.1), '#dedede');
    cyl(m, F, s, t, 0.25, 6, '#e8e8e8', shaftH + 6.5, 6);               // mast
    const p = F.p(s, t);
    // viewpoint on top of the tower: 3.8 m above the cab roof so the roof edge sits below a 60 deg camera's lower
    // edge; the mast passes through the eye but is back-face culled from inside.
    return { x: p.x, y: F.elev + shaftH + 10.5, z: p.z };
  }
  // jet bridge: tunnel from the building face (t0) toward the stand (t1) plus a rotunda at the aircraft end
  function jetBridge(m, F, s, t0, t1, hex) {
    const len = Math.abs(t1 - t0), tc = (t0 + t1) / 2;
    box(m, F, s, tc, 3.2, 3.2, len, hex, 4.2);
    cyl(m, F, s, t1, 2.6, 5.5, '#b9bcc1', 2.2, 12);
    cyl(m, F, s, t1 + (t1 > t0 ? -4 : 4), 0.35, 4.5, '#8c8f94', 0, 6);
  }
  function fuelTanks(m, F, s, t, n, r, h, pitch) {
    for (let i = 0; i < n; i++) { cyl(m, F, s + i * pitch, t, r, h, '#d9d9d4', 0, 20); cyl(m, F, s + i * pitch, t, r + 1.5, 0.6, '#9a9a96', 0, 20); }
  }
  // apron floodlight mast (25 m) with three warm omni lights
  function floodMast(m, lights, F, s, t) {
    cyl(m, F, s, t, 0.35, 25, '#b0b3b8', 0, 8);
    box(m, F, s, t, 4, 0.8, 1.2, '#4a4d52', 24.2);
    const p = F.p(s, t);
    for (let k = -1; k <= 1; k++) lights.add(p.x + F.dir.x * k * 1.4, F.elev + 24.6, p.z + F.dir.z * k * 1.4, '#ffe2b0', 2.0, 0, 0, 1.6);
  }
  // windsock: 6 m pole, orange/white striped cone pointing downwind (from FS.CONFIG.wind), drooping with light wind
  function windsock(m, F, s, t) {
    cyl(m, F, s, t, 0.12, 6, '#e8e8e8', 0, 6);
    const wind = (CFG && CFG.wind) || { fromDeg: 280, speed: 2.5 };
    const dw = G.headingToDir(wind.fromDeg + 180);
    const droop = G.clamp(60 - wind.speed * 10, 5, 60) * D2R;
    const axis = new V3(dw.x * Math.cos(droop), -Math.sin(droop), dw.z * Math.cos(droop)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, axis);
    const p = F.p(s, t);
    const top = new THREE.Matrix4().compose(new V3(p.x, F.elev + 6, p.z), q, new V3(1, 1, 1));
    const r = (y) => 0.6 - 0.42 * (y / 3.6);
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.CylinderGeometry(r((i + 1) * 0.9), r(i * 0.9), 0.9, 10, 1, true);
      seg.translate(0, i * 0.9 + 0.45, 0);
      m.add(seg, top, i % 2 === 0 ? '#ff6a00' : '#f4f4f4');
    }
  }

  // ---------------------------------------------------------------
  // Parked airliner (A321-ish, 38 m): fuselage cylinder + nose/tail
  // cones, swept wings, fin, stabilizers, engines, gear. Local frame:
  // forward = -Z, up = +Y; `heading` = compass direction of the nose.
  // ---------------------------------------------------------------
  const LIVERIES = {
    eva: { fin: '#1c8a5a', accent: '#f08a24' },
    cal: { fin: '#6b2d5c', accent: '#d9a8c9' },
    starlux: { fin: '#c9a86a', accent: '#2b2b2b' },
  };
  function airliner(m, x, z, elev, heading, livery) {
    const lv = LIVERIES[livery] || LIVERIES.eva;
    const base = new THREE.Matrix4().compose(new V3(x, elev + 0.1, z), new THREE.Quaternion().setFromAxisAngle(UP, G.headingToYaw(heading)), new V3(1, 1, 1));
    const add = (geo, hex, tx, ty, tz, rot) => {
      if (rot) geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
      geo.translate(tx, ty, tz);
      m.add(geo, base, hex);
    };
    const Y = 4.0; // fuselage axis height (gear + radius)
    // CylinderGeometry: radiusTop at +Y; rotateX(+90deg) maps +Y -> +Z (aft), so the wide end is aft for the nose
    // cone (radiusTop = 2) and forward for the tail cone (radiusBottom = 2).
    const fus = new THREE.CylinderGeometry(2, 2, 28, 16, 1, true); fus.rotateX(Math.PI / 2);
    add(fus, '#f4f4f2', 0, Y, 0);
    const nose = new THREE.CylinderGeometry(2, 0.35, 6, 16); nose.rotateX(Math.PI / 2);
    add(nose, '#f4f4f2', 0, Y, -17);
    const tail = new THREE.CylinderGeometry(0.5, 2, 9, 16); tail.rotateX(Math.PI / 2);
    add(tail, '#f4f4f2', 0, Y + 0.7, 18.5);
    add(new THREE.BoxGeometry(2.2, 0.6, 1.2), '#1d2733', 0, Y + 0.9, -15.4);                 // cockpit windows
    add(new THREE.BoxGeometry(4.6, 0.35, 28.5), lv.accent, 0, Y - 1.2, 0);                   // belly cheatline
    // wings span outward along +/-x from the root, swept aft (+z) 26 deg, 3 deg dihedral
    for (const sgn of [-1, 1]) {
      const wg = new THREE.BoxGeometry(16, 0.45, 5);
      wg.translate(sgn * 8, 0, 0);
      add(wg, '#e6e6e4', sgn * 1.5, Y - 0.6, 1.5, [0, -sgn * 26 * D2R, sgn * 3 * D2R]);
      const eng = new THREE.CylinderGeometry(1.15, 1.05, 4.2, 14); eng.rotateX(Math.PI / 2);
      add(eng, '#d9dadc', sgn * 6.5, Y - 2.0, -1.2);
      const ring = new THREE.CylinderGeometry(1.2, 1.2, 0.6, 14, 1, true); ring.rotateX(Math.PI / 2);
      add(ring, lv.fin, sgn * 6.5, Y - 2.0, -2.6);
      const stab = new THREE.BoxGeometry(6, 0.3, 2.6);
      stab.translate(sgn * 3, 0, 0);
      add(stab, '#e6e6e4', sgn * 0.8, Y + 1.0, 19.5, [0, -sgn * 28 * D2R, 0]);
      const gear = new THREE.CylinderGeometry(0.6, 0.6, 0.9, 10); gear.rotateZ(Math.PI / 2);
      add(gear, '#2a2a2a', sgn * 3.8, 0.6, 1.5);
      cylLeg(sgn * 3.8, 1.5);
    }
    const fin = new THREE.BoxGeometry(0.45, 8, 5.5); fin.translate(0, 4, 0);   // base at origin, swept aft (+z) 32 deg
    add(fin, lv.fin, 0, Y + 1.2, 17.5, [32 * D2R, 0, 0]);
    const nwheel = new THREE.CylinderGeometry(0.4, 0.4, 0.7, 10); nwheel.rotateZ(Math.PI / 2);
    add(nwheel, '#2a2a2a', 0, 0.4, -12); cylLeg(0, -12);
    function cylLeg(lx, lz) { const leg = new THREE.CylinderGeometry(0.16, 0.16, 2.6, 6); add(leg, '#9a9a9a', lx, 1.6, lz); }
  }

  // ---------------------------------------------------------------
  // Runway: end objects, edge / threshold / approach lights, PAPI.
  // X = per-airport build context {paved, statics, dyn, papis, rabbits}
  // ---------------------------------------------------------------
  const PAPI_SET = [3.5, 3.2, 2.8, 2.5]; // light k (0 = nearest the runway) shows red below this angle (deg)
  function buildRunway(ap, rc, X) {
    const L = rc.length, W = rc.width, elev = ap.elev;
    const dir = G.headingToDir(rc.heading);
    const center = { x: rc.cx, z: rc.cz };
    const thrA = { x: center.x - dir.x * L / 2, z: center.z - dir.z * L / 2 };
    const thrB = { x: center.x + dir.x * L / 2, z: center.z + dir.z * L / 2 };
    const F = makeFrame(thrA, dir, elev);
    const rw = { id: rc.id, recip: rc.recip, heading: rc.heading, center, dir, right: F.right, length: L, width: W, frame: F, ends: [] };
    const mkEnd = (id, heading, d, thr, opp) => {
      const left = { x: d.z, z: -d.x };
      const tdz = { x: thr.x + d.x * 300, z: thr.z + d.z * 300 };
      const end = {
        key: ap.icao + '-' + id, icao: ap.icao, airportName: ap.name, id, heading, dir: { x: d.x, z: d.z },
        threshold: { x: thr.x, z: thr.z }, oppositeThreshold: { x: opp.x, z: opp.z }, tdz,
        center: { x: center.x, z: center.z }, elev, length: L, width: W,
        spawn: { x: thr.x + d.x * 150, z: thr.z + d.z * 150, heading },
        papi: { x: tdz.x + left.x * (W / 2 + 15), z: tdz.z + left.z * (W / 2 + 15), side: 'left' },
        papiState: 'WWRR',
      };
      Object.defineProperty(end, 'runway', { value: rw, enumerable: false });
      return end;
    };
    const endA = mkEnd(rc.id, rc.heading, dir, thrA, thrB);
    const endB = mkEnd(rc.recip, G.wrap360(rc.heading + 180), { x: -dir.x, z: -dir.z }, thrB, thrA);
    rw.ends.push(endA, endB);
    X.paved.push(F.rect(0, L, -W / 2, W / 2, 'runway'));

    const S = X.statics, y0 = elev + 0.4;
    const WHITE = '#ffffff', AMBER = '#ffb300', GREEN = '#20ff60', RED = '#ff2a1a';
    // edge lights every 60 m, both edges; each is two directional lights so the last 600 m read amber in
    // the direction of travel only (facing -dir is seen by traffic moving along dir, i.e. landing on endA)
    for (let s = 30; s < L; s += 60) for (const side of [-1, 1]) {
      const p = F.p(s, side * (W / 2 + 1));
      S.add(p.x, y0, p.z, s > L - 600 ? AMBER : WHITE, 1.0, -dir.x, -dir.z, 1.6);
      S.add(p.x, y0, p.z, s < 600 ? AMBER : WHITE, 1.0, dir.x, dir.z, 1.6);
    }
    // threshold bars: green toward the approach, red toward the runway (end lights for the other direction);
    // green wing bars outside the edges
    for (const [s, out] of [[0, -1], [L, 1]]) {
      const ox = dir.x * out, oz = dir.z * out;
      for (let t = -W / 2; t <= W / 2 + 0.01; t += 3) {
        const p = F.p(s, t);
        S.add(p.x + ox * 0.5, y0, p.z + oz * 0.5, GREEN, 1.1, ox, oz, 1.5);
        S.add(p.x - ox * 0.5, y0, p.z - oz * 0.5, RED, 1.1, -ox, -oz, 1.5);
      }
      for (const side of [-1, 1]) for (let t = W / 2 + 3; t <= W / 2 + 24; t += 3) { const p = F.p(s, side * t); S.add(p.x, y0, p.z, GREEN, 1.1, ox, oz, 1.5); }
    }
    // approach lights (centerline bars every 30 m out to 420 m, crossbar at 300 m) + PAPI for both ends
    for (const end of rw.ends) {
      const d = end.dir, thr = end.threshold, right = { x: -d.z, z: d.x };
      const at = (back, t) => ({ x: thr.x - d.x * back + right.x * t, z: thr.z - d.z * back + right.z * t });
      const rabbit = [];
      for (let back = 420; back >= 30; back -= 30) {
        for (let t = -3; t <= 3.01; t += 1.5) { const p = at(back, t); S.add(p.x, groundY(p.x, p.z, elev) + 1, p.z, WHITE, 1.25, -d.x, -d.z, 1.7); }
        const pc = at(back, 0);
        rabbit.push(X.dyn.add(pc.x, groundY(pc.x, pc.z, elev) + 1.3, pc.z, WHITE, 1.6, -d.x, -d.z, 0));
        if (back === 300) for (const side of [-1, 1]) for (let t = 4.5; t <= 16.6; t += 1.5) { const p = at(back, side * t); S.add(p.x, groundY(p.x, p.z, elev) + 1, p.z, WHITE, 1.25, -d.x, -d.z, 1.7); }
      }
      X.rabbits.push(rabbit);
      const left = { x: d.z, z: -d.x };
      let idx = -1;
      for (let k = 0; k < 4; k++) {
        const px = end.papi.x + left.x * 9 * k, pz = end.papi.z + left.z * 9 * k;
        const i = X.dyn.add(px, elev + 0.9, pz, WHITE, 1.8, -d.x, -d.z, 2.2);
        if (k === 0) idx = i;
      }
      X.papis.push({ end, idx });
      // PAPI light boxes
      for (let k = 0; k < 4; k++) X.m.add(new THREE.BoxGeometry(0.9, 0.7, 0.6), new THREE.Matrix4().makeTranslation(end.papi.x + left.x * 9 * k, elev + 0.5, end.papi.z + left.z * 9 * k), '#3a3a3a');
    }
    return rw;
  }

  // glide angle (deg) of the aircraft above this end's PAPI, or null when the aircraft is not approaching it
  function papiAngle(end, st) {
    if (!st || !st.pos) return null;
    const px = st.pos.x, pz = st.pos.z;
    const along = G.alongTrack(px, pz, end.threshold.x, end.threshold.z, end.dir.x, end.dir.z);
    if (along > -50 || along < -15000) return null;
    const cross = G.crossTrack(px, pz, end.threshold.x, end.threshold.z, end.dir.x, end.dir.z);
    if (Math.abs(cross) > Math.tan(25 * D2R) * (-along)) return null;
    const h = Math.hypot(px - end.papi.x, pz - end.papi.z);
    return Math.atan2(st.pos.y - end.elev, Math.max(h, 1)) / D2R;
  }

  // ---------------------------------------------------------------
  // RCSS — Songshan. Frame of runway 10: s from the 10 threshold (west)
  // toward 28, t positive = right of 096 = SOUTH (terminal side).
  // ---------------------------------------------------------------
  const TW = 23; // taxiway width
  function layoutRCSS(ap, rw, X) {
    const F = rw.frame, L = rw.length, { paved, lines, m, glass, ac, statics } = X;
    const tw = (s0, s1, t0, t1) => paved.push(F.rect(s0, s1, t0, t1, 'taxiway'));
    const ln = (s0, t0, s1, t1) => lines.push([F.p(s0, t0), F.p(s1, t1)]);
    // parallel taxiway south with 4 connectors, short parallel + 2 connectors on the military side
    tw(60, L - 60, 108, 108 + TW); ln(60, 119.5, L - 60, 119.5);
    for (const s of [90, 900, 1700, L - 90]) { tw(s - TW / 2, s + TW / 2, 30, 108); ln(s, 0, s, 119.5); }
    tw(800, 2000, -108 - TW, -108); ln(800, -119.5, 2000, -119.5);
    for (const s of [1000, 1800]) { tw(s - TW / 2, s + TW / 2, -108, -30); ln(s, 0, s, -119.5); }
    // aprons: passenger apron south, military ramp north
    paved.push(F.rect(480, 1950, 131, 330, 'apron'));
    paved.push(F.rect(850, 1950, -330, -131, 'apron'));
    ln(480, 200, 1950, 200);
    // Terminal 1 (international, glass front to the apron, 6 jet bridges), Terminal 2 (domestic), landside garage
    terminalBlock(m, glass, F, 925, 360, 450, 60, 18, '#d8d9d6', [-1]);
    for (let i = 0; i < 6; i++) jetBridge(m, F, 760 + i * 70, 330, 302, '#c9cbcf');
    terminalBlock(m, glass, F, 1325, 360, 250, 50, 14, '#cfcac0', [-1]);
    box(m, F, 925, 425, 220, 14, 40, '#a4a8ad');
    ap.tower = tower(m, glass, F, 620, 372, 40, 3.5, '#e4e4e0');
    // GA / business-jet hangars east, fuel farm, apron flood masts
    hangar(m, F, 1660, 285, 80, 60, 10, 5, '#b8bcc2', '#9ea3a8');
    hangar(m, F, 1790, 285, 80, 60, 10, 5, '#b8bcc2', '#9ea3a8');
    fuelTanks(m, F, 2010, 250, 4, 7, 9, 22);
    for (const s of [560, 860, 1160, 1460, 1760]) floodMast(m, statics, F, s, 322);
    // Songshan Air Base: three arched hangars + the large presidential-flight hangar
    for (const s of [1000, 1250, 1500]) hangar(m, F, s, -378, 90, 80, 10, 8, '#c2c5c8', '#a9adb2');
    hangar(m, F, 1820, -380, 110, 80, 12, 9, '#c8ccd0', '#aeb3b8');
    for (const s of [950, 1450]) floodMast(m, statics, F, s, -140);
    // 4 airliners at the gates, nose toward the terminal (south), with lead-in lines
    const hdg = G.dirToHeading(F.right.x, F.right.z);
    const liv = ['eva', 'cal', 'starlux', 'eva'];
    for (let i = 0; i < 4; i++) { const s = 762 + i * 70, p = F.p(s, 278); airliner(ac, p.x, p.z, F.elev, hdg, liv[i]); ln(s, 200, s, 292); }
    windsock(m, F, L / 2, -(rw.width / 2 + 100));
    X.grass.push(F.rect(-80, L + 80, -440, 450, 'grass'));
  }

  // ---------------------------------------------------------------
  // RCTP — Taoyuan. Frame of 05L: s from the 05L threshold (southwest)
  // toward 23R, t positive = right of 050 = SOUTHEAST, toward 05R/23L.
  // Terminals sit between the runways, cargo to the west.
  // ---------------------------------------------------------------
  function layoutRCTP(ap, rwL, rwR, X) {
    const F = rwL.frame, L = rwL.length, { paved, lines, m, glass, ac, statics } = X;
    const o = F.st(rwR.frame.origin.x, rwR.frame.origin.z); // 05R threshold in the 05L frame
    const tR = o.t, sR0 = o.s, LR = rwR.length, tc = tR / 2;
    const tw = (s0, s1, t0, t1) => paved.push(F.rect(s0, s1, t0, t1, 'taxiway'));
    const ln = (s0, t0, s1, t1) => lines.push([F.p(s0, t0), F.p(s1, t1)]);
    // inner + outer parallel taxiways for both runways, six connectors each, two cross taxiways through the apron
    tw(60, L - 60, 138, 138 + TW); ln(60, 149.5, L - 60, 149.5);
    tw(60, L - 60, -138 - TW, -138); ln(60, -149.5, L - 60, -149.5);
    tw(sR0 + 60, sR0 + LR - 60, tR - 138 - TW, tR - 138); ln(sR0 + 60, tR - 149.5, sR0 + LR - 60, tR - 149.5);
    tw(sR0 + 60, sR0 + LR - 60, tR + 138, tR + 138 + TW); ln(sR0 + 60, tR + 149.5, sR0 + LR - 60, tR + 149.5);
    for (const s of [150, 800, 1500, 2200, 2900, L - 150]) { tw(s - TW / 2, s + TW / 2, -138, 138); ln(s, -149.5, s, 149.5); }
    for (const s of [150, 800, 1500, 2200, 2900, LR - 150]) { const ss = sR0 + s; tw(ss - TW / 2, ss + TW / 2, tR - 138, tR + 138); ln(ss, tR - 149.5, ss, tR + 149.5); }
    for (const s of [700, 3000]) { tw(s - TW / 2, s + TW / 2, 161, tR - 161); ln(s, 149.5, s, tR - 149.5); }
    // aprons: central (terminals), cargo west, maintenance east
    paved.push(F.rect(750, 3100, 250, tR - 250, 'apron'));
    paved.push(F.rect(100, 700, 300, 950, 'apron'));
    paved.push(F.rect(3150, 3550, 400, 950, 'apron'));
    ln(750, 320, 3100, 320); ln(750, tR - 320, 3100, tR - 320); ln(100, 600, 700, 600);
    // Terminal 1: curved roof, glass both sides, two piers. Terminal 2: 400 m block with two long concourses.
    hangar(m, F, 1200, tc, 300, 90, 20, 12, '#cdc8bc', '#b7b2a6');
    for (const side of [-1, 1]) glass.add(new THREE.BoxGeometry(280, 12, 1), place(F, 1200, tc + side * 45.6, 2.5 + 6), '#3d6480');
    box(m, F, 1200, tc - 150, 32, 12, 200, '#d5d2ca');
    box(m, F, 1200, tc + 150, 32, 12, 200, '#d5d2ca');
    terminalBlock(m, glass, F, 2350, tc, 400, 100, 28, '#dcdcd8', [-1, 1]);
    box(m, F, 2350, tc - 235, 36, 14, 370, '#e2e2de');
    box(m, F, 2350, tc + 235, 36, 14, 370, '#e2e2de');
    // landside between the terminals: two parking garages, hotel; control tower
    box(m, F, 1600, tc + 20, 150, 16, 70, '#a9adb3');
    box(m, F, 1800, tc + 20, 150, 16, 70, '#a9adb3');
    box(m, F, 1980, tc - 60, 110, 44, 36, '#c9ccd2');
    glass.add(new THREE.BoxGeometry(100, 36, 1), place(F, 1980, tc - 60 - 18.6, 4 + 18), '#3d6480');
    ap.tower = tower(m, glass, F, 1700, tc - 140, 66, 4.5, '#e6e6e2');
    // cargo hangars west, maintenance hangars east, fuel farm, flood masts
    for (const s of [250, 420, 590]) hangar(m, F, s, 1010, 140, 80, 14, 6, '#b8bcc2', '#9ea3a8');
    for (const s of [3250, 3480]) hangar(m, F, s, 1010, 200, 100, 22, 8, '#c4c7cb', '#a9adb2');
    fuelTanks(m, F, 150, 1150, 6, 14, 14, 36);
    for (const s of [900, 1500, 2100, 2700]) { floodMast(m, statics, F, s, 262); floodMast(m, statics, F, s, tR - 262); }
    // 8 airliners: 4 on T1's north pier, 4 on T2's north concourse, nose toward the pier, with jet bridges
    const hAlong = G.dirToHeading(F.dir.x, F.dir.z), hBack = G.wrap360(hAlong + 180);
    const liv = ['eva', 'cal', 'starlux', 'cal', 'eva', 'starlux', 'cal', 'eva'];
    const stands = [[1158, tc - 200, hAlong, 1184], [1158, tc - 120, hAlong, 1184], [1242, tc - 200, hBack, 1216], [1242, tc - 120, hBack, 1216],
      [2306, tc - 380, hAlong, 2332], [2306, tc - 290, hAlong, 2332], [2394, tc - 380, hBack, 2368], [2394, tc - 290, hBack, 2368]];
    stands.forEach(([s, t, h, edge], i) => {
      const p = F.p(s, t); airliner(ac, p.x, p.z, F.elev, h, liv[i]);
      const noseS = s + (h === hAlong ? 19 : -19);
      box(m, F, (edge + noseS) / 2, t + 2, Math.abs(edge - noseS) + 2, 3.2, 3.2, '#c9cbcf', 4.2);
      cyl(m, F, noseS + (h === hAlong ? 1 : -1), t + 2, 2.6, 5.5, '#b9bcc1', 2.2, 12);
      ln(s - (h === hAlong ? 60 : -60), t, noseS, t);
    });
    windsock(m, F, L / 2, -(rwL.width / 2 + 100));
    windsock(m, F, sR0 + LR / 2, tR + rwR.width / 2 + 100);
    X.grass.push(F.rect(-300, L + 300, -450, tR + 450, 'grass'));
  }

  // ---------------------------------------------------------------
  // Ground painting (grass footprint, aprons, taxiways, runways) so
  // the terrain texture / minimap show the airports from any distance.
  // ---------------------------------------------------------------
  function paintAll(ctx, mapper, layouts) {
    const r = mapper.rect;
    const rr = (q, color, alpha) => {
      ctx.save(); ctx.translate(q.cx, q.cz); ctx.rotate(Math.atan2(q.dir.z, q.dir.x));
      ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.fillStyle = color;
      ctx.fillRect(-q.along / 2, -q.across / 2, q.along, q.across); ctx.restore();
    };
    for (const X of layouts) {
      const a = X.airport;
      if (a.x + 5000 < r.x0 || a.x - 5000 > r.x1 || a.z + 5000 < r.z0 || a.z - 5000 > r.z1) continue;
      for (const g of X.grass) {
        rr(g, '#7a9a52');
        const F = g.frame;
        for (let i = 0; i < 16; i++) {            // mowing patches
          const s = g.s0 + rand() * (g.s1 - g.s0), t = g.t0 + rand() * (g.t1 - g.t0), w = 150 + rand() * 350;
          rr(F.rect(s - w, s + w, t - 60, t + 60), rand() < 0.5 ? '#6f8f48' : '#86a45c', 0.45);
        }
      }
      for (const p of X.paved) if (p.kind === 'apron') rr(p, '#8a8a86');
      for (const p of X.paved) if (p.kind === 'taxiway') rr(p, '#6f6f6c');
      for (const p of X.paved) if (p.kind === 'runway') rr(p, '#3a3b3a');
      ctx.save();
      const lw = Math.max(0.6, 1.5 / mapper.pxPerM); // at least ~1.5 px so lines survive the coarse canvases
      ctx.lineWidth = lw; ctx.globalAlpha = 0.85; ctx.strokeStyle = '#d8b53a'; ctx.beginPath();
      for (const [p, q] of X.lines) { ctx.moveTo(p.x, p.z); ctx.lineTo(q.x, q.z); }
      ctx.stroke();
      ctx.strokeStyle = '#e8e8e8'; ctx.setLineDash([30, 20]); ctx.beginPath();
      for (const p of X.paved) if (p.kind === 'runway') { const F = p.frame, a1 = F.p(p.s0 + 80, 0), b1 = F.p(p.s1 - 80, 0); ctx.moveTo(a1.x, a1.z); ctx.lineTo(b1.x, b1.z); }
      ctx.stroke(); ctx.restore();
    }
  }

  // ---------------------------------------------------------------
  // Module state, init, API
  // ---------------------------------------------------------------
  const airports = [], allEnds = [], endByKey = new Map(), pavedAll = [], runwayRects = [], dynamics = [];
  let time = 0, mats = null;

  function makeMaterials() {
    const std = (o) => new THREE.MeshStandardMaterial(o);
    return {
      bldg: std({ vertexColors: true, roughness: 0.85, metalness: 0.02 }),
      glass: std({ vertexColors: true, roughness: 0.2, metalness: 0.6 }),
      ac: std({ vertexColors: true, roughness: 0.45, metalness: 0.2 }),
      taxi: std({ map: taxiwayTexture(), color: FS.color('#ffffff'), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      apron: std({ map: apronTexture(), color: FS.color('#ffffff'), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      line: std({ color: FS.color('#e0b93a'), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      light: lightMaterial(),
    };
  }

  function buildAirport(cfg, scene, layouts) {
    const ap = { icao: cfg.icao, name: cfg.name, x: cfg.x, z: cfg.z, elev: cfg.elev, tower: null, runways: [], ends: [] };
    const X = { airport: ap, paved: [], lines: [], grass: [], m: new Merger(), glass: new Merger(), ac: new Merger(),
      statics: new LightSet(), dyn: new LightSet(), papis: [], rabbits: [] };
    for (const rc of cfg.runways) {
      const rw = buildRunway(ap, rc, X);
      ap.runways.push(rw); ap.ends.push(rw.ends[0], rw.ends[1]);
      scene.add(buildRunwayMesh(rw, ap.elev));
      runwayRects.push({ rect: X.paved[X.paved.length - 1], end: rw.ends[0] });
    }
    if (cfg.icao === 'RCSS') layoutRCSS(ap, ap.runways[0], X);
    else if (cfg.icao === 'RCTP' && ap.runways.length > 1) layoutRCTP(ap, ap.runways[0], ap.runways[1], X);
    else { const F = ap.runways[0].frame, L = ap.runways[0].length; X.paved.push(F.rect(60, L - 60, 108, 131, 'taxiway'), F.rect(400, L - 400, 131, 300, 'apron')); X.grass.push(F.rect(-80, L + 80, -300, 400, 'grass')); }
    ap.frame = ap.runways[0].frame;
    if (!ap.tower) ap.tower = { x: ap.x, y: ap.elev + 30, z: ap.z };
    // rotating beacon: white + green points at the tower mast, animated in update()
    const beacon = { w: X.dyn.add(ap.tower.x, ap.tower.y + 2.2, ap.tower.z, '#ffffff', 3.0, 0, 0, 0), g: X.dyn.add(ap.tower.x, ap.tower.y + 2.2, ap.tower.z, '#20ff60', 3.0, 0, 0, 0) };
    // blue taxiway edge lights every 40 m along both long edges of every taxiway piece
    for (const p of X.paved) {
      if (p.kind !== 'taxiway') continue;
      const F = p.frame, alongS = p.along >= p.across;
      const n = Math.floor((alongS ? p.along : p.across) / 40);
      for (let i = 0; i <= n; i++) {
        const u = (alongS ? p.s0 : p.t0) + 20 + i * 40;
        if (u > (alongS ? p.s1 : p.t1)) break;
        for (const side of [0, 1]) {
          const q = alongS ? F.p(u, side ? p.t1 + 0.6 : p.t0 - 0.6) : F.p(side ? p.s1 + 0.6 : p.s0 - 0.6, u);
          X.statics.add(q.x, ap.elev + 0.35, q.z, '#2a4cff', 0.7, 0, 0, 1.5);
        }
      }
    }
    // meshes: buildings, glass, airliners (merged, vertex colors), taxiways, aprons, taxi lines
    const bm = X.m.mesh(mats.bldg, true, true); if (bm) scene.add(bm);
    const gm = X.glass.mesh(mats.glass, true, false); if (gm) scene.add(gm);
    const am = X.ac.mesh(mats.ac, true, true); if (am) scene.add(am);
    const tx = new Merger(), apm = new Merger(), lm = new Merger();
    for (const p of X.paved) {
      if (p.kind === 'taxiway') tx.rect(p, ap.elev + 0.10, '#ffffff', 20);
      else if (p.kind === 'apron') apm.rect(p, ap.elev + 0.08, '#ffffff', 30);
    }
    for (const [a, b] of X.lines) lm.strip(a, b, 0.6, ap.elev + 0.13, '#ffffff');
    for (const [mg, mt] of [[apm, mats.apron], [tx, mats.taxi], [lm, mats.line]]) { const mesh = mg.mesh(mt, false, true); if (mesh) scene.add(mesh); }
    scene.add(X.statics.points(mats.light, false));
    const dp = X.dyn.points(mats.light, true); scene.add(dp);
    dynamics.push({ points: dp, papis: X.papis, rabbits: X.rabbits, beacon });
    for (const p of X.paved) pavedAll.push(p);
    for (const e of ap.ends) { allEnds.push(e); endByKey.set(e.key, e); }
    airports.push(ap);
    layouts.push(X);
  }

  function init(scene) {
    const t0 = performance.now();
    const layouts = [];
    try {
      mats = makeMaterials();
      for (const cfg of (CFG && CFG.airports) || []) {
        try { buildAirport(cfg, scene, layouts); } catch (e) { console.error('[airports] ' + cfg.icao + ' failed', e); }
      }
    } catch (e) { console.error('[airports] init failed', e); }
    try {
      if (FS.world && typeof FS.world.paintGround === 'function') FS.world.paintGround((ctx, mapper) => paintAll(ctx, mapper, layouts));
    } catch (e) { console.error('[airports] paintGround failed', e); }
    update(0, null);
    console.log('[airports] ' + airports.length + ' airports, ' + allEnds.length + ' runway ends, ' + Math.round(performance.now() - t0) + ' ms');
  }

  function update(dt, st) {
    time += dt || 0;
    const cyc = time % 2;
    for (const d of dynamics) {
      const col = d.points.geometry.attributes.color, arr = col.array;
      const setC = (i, r, g, b) => { arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; };
      const wf = cyc < 0.12 ? 1 : 0, gf = cyc > 1.0 && cyc < 1.12 ? 1 : 0;   // beacon: white / green flashes, 2 s cycle
      setC(d.beacon.w, 2.4 * wf, 2.4 * wf, 2.4 * wf); setC(d.beacon.g, 0.3 * gf, 2.6 * gf, 0.9 * gf);
      for (const rb of d.rabbits) {                                            // sequenced flasher running toward the threshold
        const k = Math.floor((time % 1) * rb.length);
        for (let i = 0; i < rb.length; i++) { const on = i === k ? 2.8 : 0; setC(rb[i], on, on, on * 0.95); }
      }
      for (const p of d.papis) {
        const ang = papiAngle(p.end, st), a = ang == null ? 3.0 : ang;
        let s = '';
        for (let k = 3; k >= 0; k--) {
          const red = a < PAPI_SET[k]; s += red ? 'R' : 'W';
          if (red) setC(p.idx + k, 2.6, 0.12, 0.08); else setC(p.idx + k, 2.3, 2.2, 2.0);
        }
        p.end.papiState = s;
      }
      col.needsUpdate = true;
    }
  }

  FS.airports = {
    list: airports,
    init, update,
    getRunwayEnds() { return allEnds.slice(); },
    getRunwayEnd(key) { return endByKey.get(key); },
    isOnRunway(x, z) { for (const r of runwayRects) if (inRect(r.rect, x, z)) return r.end; return null; },
    isOnPaved(x, z) { for (const p of pavedAll) if (inRect(p, x, z)) return true; return false; },
    nearest(x, z) { let best = null, bd = Infinity; for (const a of airports) { const d = G.dist(a.x, a.z, x, z); if (d < bd) { bd = d; best = a; } } return best; },
  };
})();
