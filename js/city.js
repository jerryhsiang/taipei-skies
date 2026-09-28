/* ============================================================
   Taipei Skies — js/city.js
   Streets, blocks and the sea of buildings, landmarks, bridges, parks and trees of Taipei.
   Plain script, one IIFE, attaches FS.city only.

   API (CONTRACT.md):
     FS.city.init(scene)              paints streets/blocks/parks/plazas/expressways onto the ground via FS.world.paintGround,
                                      builds instanced buildings (tiled InstancedMesh, per-instance colour + window pattern),
                                      landmarks, bridges, trees, outer towns and the obstacle grids
     FS.city.getObstacleTop(x, z)     highest structure top (m MSL) in the 50 m cell + 8 neighbours (100 m cells outside the inner rect), else -Infinity
     FS.city.landmarks                [{name, x, z, top}] tallest first (landmarks actually built)
     FS.city.update(dt, cameraPos)    ferris wheel animation (only when the camera is within 8 km)
     FS.city.setQuality(q)            rebuilds buildings/trees for 'low' | 'medium' | 'high' (instance caps 30k / 70k / 130k)
     FS.city.stats                    counts + init timings (for the loading log / debugging)

   Additions beyond the contract: none required. Works without FS.world (flat land, config rivers as water).
   Structure: [helpers part] geometry builders + window-pattern material patch -> [landmarks part] explicit landmark meshes
              -> [core] density field, districts, blocks/lots, instancing, obstacle grids, bridges, trees, painting, API.
   ============================================================ */
(function () {
  'use strict';

  // ================= PART 1/3: helpers (geometry, materials, window shader) =================
  (function () {
    'use strict';
    const FS = window.FS;

    // ---- procedural window pattern (onBeforeCompile for MeshLambert/MeshStandard) ----
    // Works for InstancedMesh (per-instance `aWin` attribute) and plain meshes (uniform uWin).
    // Mode 0: none, 1: punched windows every 3.2 m (floors) x 2.6 m (columns), 2: glass curtain-wall bands.
    const VERT_PARS = [
      '#include <common>',
      'attribute float aWin;',
      'uniform float uWin;',
      'varying vec3 vWPos;',
      'varying vec3 vWNrm;',
      'varying float vWin;',
      'varying float vHgt;',
      'varying float vDist;',
      'varying float vSeed;',
    ].join('\n');
    const VERT_BODY = [
      '#include <begin_vertex>',
      '{',
      '  vec4 cwp = vec4( transformed, 1.0 );',
      '  vec3 cwn = vec3( normal );',
      '  float csy = 1.0;',
      '  vec3 cwo = modelMatrix[ 3 ].xyz;',
      '  #ifdef USE_INSTANCING',
      '    cwp = instanceMatrix * cwp;',
      '    cwn = mat3( instanceMatrix ) * cwn;',
      '    csy = length( instanceMatrix[ 1 ].xyz );',
      '    cwo = instanceMatrix[ 3 ].xyz;',
      '  #endif',
      '  cwp = modelMatrix * cwp;',
      '  vWPos = cwp.xyz;',
      '  vWNrm = normalize( mat3( modelMatrix ) * cwn );',
      '  vWin = uWin + aWin;',
      '  vHgt = position.y * csy;',
      // one pseudo-random number per building (from its origin), constant over all of its faces
      '  vSeed = fract( sin( dot( cwo.xz, vec2( 0.01271, 0.03117 ) ) ) * 43758.5453 );',
      '}',
    ].join('\n');
    const VERT_PROJ = [
      '#include <project_vertex>',
      'vDist = -mvPosition.z;',
    ].join('\n');
    const FRAG_PARS = [
      '#include <common>',
      'varying vec3 vWPos;',
      'varying vec3 vWNrm;',
      'varying float vWin;',
      'varying float vHgt;',
      'varying float vDist;',
      'varying float vSeed;',
    ].join('\n');
    const FRAG_BODY = [
      '#include <color_fragment>',
      '{',
      '  vec3 cwN = normalize( vWNrm );',
      '  float cwRoof = step( 0.6, cwN.y );',
      // roofs dominate from the air: dark membrane / weathered concrete / green-grey waterproofing per building,
      // with coarse patch variation (repairs, puddles). Rooftop sheds and tanks (vWin == 0) keep their own colour.
      '  {',
      '    float rs = fract( vSeed * 7.31 );',
      '    vec3 rt = mix( vec3( 0.070, 0.070, 0.066 ), vec3( 0.205, 0.200, 0.185 ), rs * rs );',
      '    rt = mix( rt, vec3( 0.115, 0.150, 0.105 ), step( 0.82, fract( vSeed * 3.17 ) ) * 0.75 );',
      '    float roofPatch = fract( sin( dot( floor( vWPos.xz / 6.5 ), vec2( 127.1, 311.7 ) ) ) * 43758.5453 );',
      '    rt *= 0.82 + 0.32 * roofPatch;',
      '    vec3 roofCol = mix( mix( rt, diffuseColor.rgb, 0.18 ), diffuseColor.rgb * 0.8, step( vWin, 0.5 ) );',
      '    diffuseColor.rgb = mix( diffuseColor.rgb, roofCol, cwRoof );',
      '  }',
      '  float cwSide = ( 1.0 - cwRoof ) * step( 0.5, vWin );',
      '  if ( cwSide > 0.5 ) {',
      '    float cwFade = 1.0 - smoothstep( 650.0, 1700.0, vDist );',
      '    float cwGlass = step( 1.5, vWin );',
      '    float cwH = dot( vWPos.xz, vec2( -cwN.z, cwN.x ) );',
      '    float cwFl = vHgt / 3.2;',
      '    float cwFy = fract( cwFl );',
      '    float cwCol = cwH / 2.6;',
      '    float cwFx = fract( cwCol );',
      '    float cwWy = step( 0.28, cwFy ) * step( cwFy, 0.80 );',
      '    float cwWx = max( cwGlass, step( 0.20, cwFx ) * step( cwFx, 0.78 ) );',
      '    float cwId = fract( sin( dot( vec2( floor( cwFl ), mod( floor( cwCol ), 89.0 ) ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );',
      '    float cwDark = mix( mix( 0.42, 0.78, cwId ), 0.66, cwGlass );',
      '    float cwW = cwWy * cwWx * step( 1.0, cwFl );',
      '    float cwAvg = mix( 0.90, 0.85, cwGlass );',
      '    diffuseColor.rgb *= mix( cwAvg, mix( 1.0, cwDark, cwW ), cwFade );',
      // shopfronts / grime on the ground floor
      '    diffuseColor.rgb *= mix( 0.72, 1.0, smoothstep( 0.0, 4.2, vHgt ) );',
      '  }',
      '}',
    ].join('\n');

    function patchWindows(material, mode) {
      mode = mode || 0;
      material.onBeforeCompile = function (shader) {
        shader.uniforms.uWin = { value: mode };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', VERT_PARS)
          .replace('#include <begin_vertex>', VERT_BODY)
          .replace('#include <project_vertex>', VERT_PROJ);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', FRAG_PARS)
          .replace('#include <color_fragment>', FRAG_BODY);
      };
      // identical shader source for every mode (mode is a uniform) -> one program per base material type
      material.customProgramCacheKey = function () { return 'city-windows-v2'; };
      material.userData.windowMode = mode;
      return material;
    }

    FS.__cityHelpers = function (env) {
      const matCache = new Map();
      function mat(hex, opts) {
        opts = opts || {};
        const key = hex + '|' + (opts.glass ? 'g' : 'l') + '|' + (opts.rough == null ? '' : opts.rough) + '|' + (opts.metal == null ? '' : opts.metal) +
          '|' + (opts.win || 0) + '|' + (opts.emissive || '') + '|' + (opts.side || '');
        let m = matCache.get(key);
        if (m) return m;
        if (opts.glass) {
          m = new THREE.MeshStandardMaterial({ color: FS.color(hex), roughness: opts.rough == null ? 0.35 : opts.rough, metalness: opts.metal == null ? 0.25 : opts.metal });
        } else {
          m = new THREE.MeshLambertMaterial({ color: FS.color(hex) });
        }
        if (opts.emissive) { m.emissive = FS.color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity == null ? 0.6 : opts.emissiveIntensity; }
        if (opts.side) m.side = opts.side;
        if (opts.win) patchWindows(m, opts.win);
        matCache.set(key, m);
        return m;
      }

      // ---- geometry ----
      function nonIndexed(g) { return g.index ? g.toNonIndexed() : g; }
      function flatNormals(g) { g = nonIndexed(g); g.computeVertexNormals(); return g; }

      // Builds a non-indexed geometry from quads; each quad's normal is flipped to face away from `centre`.
      function quadsGeometry(quads, centre) {
        const pos = [], nrm = [];
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), fc = new THREE.Vector3();
        for (const q of quads) {
          let v = q.slice();
          a.fromArray(v[0]); b.fromArray(v[1]); c.fromArray(v[2]);
          n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
          fc.set(0, 0, 0); for (const p of v) fc.add(new THREE.Vector3().fromArray(p)); fc.multiplyScalar(1 / v.length).sub(centre);
          if (n.dot(fc) < 0) { v = [v[0], v[3], v[2], v[1]]; n.negate(); }
          const tris = v.length === 4 ? [v[0], v[1], v[2], v[0], v[2], v[3]] : [v[0], v[1], v[2]];
          for (const p of tris) { pos.push(p[0], p[1], p[2]); nrm.push(n.x, n.y, n.z); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        return g;
      }

      const geo = {
        box(w, h, d) { const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0); return flatNormals(g); },
        frustum(wb, db, wt, dt, h) {
          const b = [[-wb / 2, 0, -db / 2], [wb / 2, 0, -db / 2], [wb / 2, 0, db / 2], [-wb / 2, 0, db / 2]];
          const t = [[-wt / 2, h, -dt / 2], [wt / 2, h, -dt / 2], [wt / 2, h, dt / 2], [-wt / 2, h, dt / 2]];
          const quads = [];
          for (let i = 0; i < 4; i++) { const j = (i + 1) & 3; quads.push([b[i], b[j], t[j], t[i]]); }
          if (wt > 0.01 && dt > 0.01) quads.push([t[0], t[1], t[2], t[3]]);
          return quadsGeometry(quads, new THREE.Vector3(0, h / 2, 0));
        },
        cyl(rTop, rBottom, h, seg) {
          const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, false); g.translate(0, h / 2, 0);
          return seg <= 8 ? flatNormals(g) : nonIndexed(g);
        },
        cone(r, h, seg) {
          const g = new THREE.ConeGeometry(r, h, seg, 1, false); g.translate(0, h / 2, 0);
          return seg <= 8 ? flatNormals(g) : nonIndexed(g);
        },
        dome(r, h, seg) {
          const g = new THREE.SphereGeometry(1, seg, Math.max(3, Math.ceil(seg / 2)), 0, Math.PI * 2, 0, Math.PI / 2);
          g.scale(r, h, r); g.computeVertexNormals(); return nonIndexed(g);
        },
        torus(R, tube, radialSeg, tubularSeg, arc) {
          const g = new THREE.TorusGeometry(R, tube, radialSeg, tubularSeg, arc == null ? Math.PI * 2 : arc);
          return nonIndexed(g);
        },
        xf(g, o) {
          o = o || {};
          if (o.sx != null || o.sy != null || o.sz != null) g.scale(o.sx == null ? 1 : o.sx, o.sy == null ? 1 : o.sy, o.sz == null ? 1 : o.sz);
          if (o.rx) g.rotateX(o.rx);
          if (o.rz) g.rotateZ(o.rz);
          if (o.ry) g.rotateY(o.ry);
          if (o.x || o.y || o.z) g.translate(o.x || 0, o.y || 0, o.z || 0);
          return g;
        },
        merge(list) {
          let n = 0;
          const parts = list.map((g) => { g = nonIndexed(g); n += g.attributes.position.count; return g; });
          const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
          let off = 0;
          for (const g of parts) {
            const p = g.attributes.position.array, c = g.attributes.position.count;
            pos.set(p.subarray ? p.subarray(0, c * 3) : p, off * 3);
            let na = g.attributes.normal;
            if (!na) { g.computeVertexNormals(); na = g.attributes.normal; }
            nrm.set(na.array.subarray ? na.array.subarray(0, c * 3) : na.array, off * 3);
            off += c;
          }
          const out = new THREE.BufferGeometry();
          out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
          return out;
        },
      };

      function mesh(g, m, opts) {
        const me = new THREE.Mesh(g, m);
        const sh = !(opts && opts.shadow === false);
        me.castShadow = sh; me.receiveShadow = sh;
        return me;
      }

      function lm(name) {
        const list = (FS.CONFIG && FS.CONFIG.landmarks) || [];
        for (const l of list) if (l.name === name) return l;
        return null;
      }

      return {
        cfg: FS.CONFIG, lm, ground: env.ground, color: FS.color, mat, geo, mesh, patchWindows,
        obstacle: { rect: env.obstacleRect, circle: env.obstacleCircle },
      };
    };
    FS.__cityPatchWindows = patchWindows;
  })();

  // ================= PART 2/3: landmarks =================
  (function () {
    'use strict';
    const FS = window.FS;
    const PI = Math.PI;

    FS.__cityLandmarks = function (H) {
      const records = [];
      if (!H || !H.geo || typeof H.mat !== 'function' || typeof H.mesh !== 'function' || typeof H.lm !== 'function') {
        console.warn('[city] landmarks: helper API missing, nothing built');
        return records;
      }
      const G = H.geo;
      const box = G.box, frustum = G.frustum, cyl = G.cyl, cone = G.cone, dome = G.dome, torus = G.torus, xf = G.xf;
      const OB = H.obstacle || {};

      // Merge a list of baked geometries (or pass one through) and add ONE mesh in the given material.
      function put(parent, geos, hex, opts) {
        const list = Array.isArray(geos) ? geos : [geos];
        const g = list.length === 1 ? list[0] : G.merge(list);
        const m = H.mesh(g, H.mat(hex, opts || {}));
        parent.add(m);
        return m;
      }

      // Obstacles: local offsets (lx, lz) and local tops are converted to absolute world coords / m MSL.
      function rect(o, lx, lz, w, d, top) { if (typeof OB.rect === 'function') OB.rect(o.x + lx, o.z + lz, w, d, 0, o.gy + top); }
      function circle(o, lx, lz, r, top) { if (typeof OB.circle === 'function') OB.circle(o.x + lx, o.z + lz, r, o.gy + top); }

      // Runs one landmark builder inside its own try/catch. `build(o)` returns the structure height (m above ground).
      function add(name, build) {
        try {
          const l = H.lm(name);
          if (!l) throw new Error('not found in FS.CONFIG.landmarks');
          const x = l.x, z = l.z;
          let gy = H.ground(x, z);
          if (!Number.isFinite(gy)) gy = 0;
          const group = new THREE.Group();
          group.name = 'landmark:' + name;
          group.position.set(x, gy, z);
          const rec = { name, x, z, top: gy, group, animate: null };
          const o = { x, z, gy, group, rec };
          const h = build(o);
          rec.top = gy + (Number.isFinite(h) ? h : 0);
          records.push(rec);
        } catch (e) {
          console.warn('[city] landmark failed', name, e);
        }
      }

      // ---------------------------------------------------------------
      // 1. Taipei 101 (508 m): tapered base, 8 inverted-trapezoid segments,
      //    stepped top tower, spire; mall podium on the west side.
      // ---------------------------------------------------------------
      add('Taipei 101', (o) => {
        const glass = [frustum(76, 76, 52, 52, 100)];
        for (let i = 0; i < 8; i++) glass.push(xf(frustum(40, 40, 54, 54, 31), { y: 100 + 31 * i }));
        glass.push(xf(box(32, 40, 32), { y: 348 }));
        glass.push(xf(box(26, 34, 26), { y: 388 }));
        glass.push(xf(box(18, 28, 18), { y: 422 }));
        put(o.group, glass, '#6f8f8a', { glass: true, win: 2 });
        put(o.group, xf(cyl(0.5, 2.6, 58, 8), { y: 450 }), '#9aa5a8');
        // mall podium (kept inside the 260 x 260 site: spans x-128 .. x-8)
        put(o.group, xf(box(120, 22, 100), { x: -68 }), '#8fa8a4', { glass: true, win: 2 });
        rect(o, 0, 0, 80, 80, 508);
        rect(o, -68, 0, 122, 102, 22);
        return 508;
      });

      // ---------------------------------------------------------------
      // 2. Nan Shan Plaza (272 m): faceted 8-sided tapered prism + crown.
      // ---------------------------------------------------------------
      add('Nan Shan Plaza', (o) => {
        put(o.group, [cyl(18, 24, 262, 8), xf(cone(18, 10, 8), { y: 262 })], '#8fb0b5', { glass: true, win: 2 });
        circle(o, 0, 0, 26, 272);
        return 272;
      });

      // ---------------------------------------------------------------
      // 3. Shin Kong Life Tower (244 m): slender granite box + pyramid cap.
      // ---------------------------------------------------------------
      add('Shin Kong Life Tower', (o) => {
        put(o.group, box(38, 236, 38), '#b3aca0', { win: 1 });
        put(o.group, xf(cone(27, 8, 4), { ry: PI / 4, y: 236 }), '#6d6a66');
        rect(o, 0, 0, 42, 42, 244);
        return 244;
      });

      // ---------------------------------------------------------------
      // 4. Taipei Main Station: 400 x 160 block, brown hip roof, clock tower.
      // ---------------------------------------------------------------
      add('Taipei Main Station', (o) => {
        put(o.group, box(400, 30, 160), '#cdbfa5', { win: 1 });
        put(o.group, [xf(frustum(404, 164, 300, 80, 16), { y: 30 }), xf(box(20, 12, 20), { y: 46 })], '#6b4a3a');
        rect(o, 0, 0, 406, 166, 46);
        rect(o, 0, 0, 22, 22, 58);
        return 58;
      });

      // ---------------------------------------------------------------
      // 5. Presidential Office: red-brick ring around a courtyard, long axis
      //    N-S, front (with the 60 m tower) facing EAST (+x).
      // ---------------------------------------------------------------
      add('Presidential Office', (o) => {
        const brick = [
          xf(box(24, 24, 200), { x: 47 }),   // front bar (east)
          xf(box(24, 24, 200), { x: -47 }),  // back bar (west)
          xf(box(70, 24, 24), { z: -88 }),   // north wing
          xf(box(70, 24, 24), { z: 88 }),    // south wing
          xf(box(16, 60, 16), { x: 47 }),    // central tower on the front bar
        ];
        put(o.group, brick, '#8c3b2e', { win: 1 });
        put(o.group, xf(cone(11, 6, 4), { ry: PI / 4, x: 47, y: 60 }), '#5a4438');
        rect(o, 47, 0, 26, 202, 24);
        rect(o, -47, 0, 26, 202, 24);
        rect(o, 0, -88, 72, 26, 24);
        rect(o, 0, 88, 72, 26, 24);
        rect(o, 47, 0, 18, 18, 66);
        return 66;
      });

      // ---------------------------------------------------------------
      // 6. CKS Memorial Hall: white hall with a blue octagonal roof at the
      //    east end of the park, National Theater / Concert Hall flanking,
      //    white gate at the west end.
      // ---------------------------------------------------------------
      add('CKS Memorial Hall', (o) => {
        const hx = 150;
        put(o.group, xf(frustum(110, 110, 96, 96, 14), { x: hx }), '#e8e6e0');
        put(o.group, xf(box(70, 32, 70), { x: hx, y: 14 }), '#f0eee8', { win: 1 });
        put(o.group, xf(cone(48, 30, 8), { x: hx, y: 46 }), '#2c4f9e');
        put(o.group, xf(cyl(0.5, 1.8, 4, 6), { x: hx, y: 74 }), '#d9b04a'); // gold finial
        // National Theater (north) and Concert Hall (south)
        const bodies = [xf(box(100, 20, 60), { x: -60, z: -150 }), xf(box(100, 20, 60), { x: -60, z: 150 })];
        const roofs = [xf(frustum(106, 66, 60, 20, 14), { x: -60, y: 20, z: -150 }), xf(frustum(106, 66, 60, 20, 14), { x: -60, y: 20, z: 150 })];
        put(o.group, bodies, '#c7b79a', { win: 1 });
        put(o.group, roofs, '#c8842c');
        // gate arch at the west end: two pillars + lintel spanning N-S
        const gate = [xf(box(8, 28, 8), { x: -215, z: -20 }), xf(box(8, 28, 8), { x: -215, z: 20 }), xf(box(8, 8, 56), { x: -215, y: 24 })];
        put(o.group, gate, '#f0eee8');
        rect(o, hx, 0, 112, 112, 14);
        rect(o, hx, 0, 74, 74, 78);
        rect(o, -60, -150, 108, 68, 34);
        rect(o, -60, 150, 108, 68, 34);
        rect(o, -215, 0, 10, 58, 32);
        return 78;
      });

      // ---------------------------------------------------------------
      // 7. Grand Hotel (87 m): red palace block with a Chinese hip roof on a
      //    hill; the front faces SOUTH (+z) toward the Keelung River.
      // ---------------------------------------------------------------
      add('Grand Hotel', (o) => {
        put(o.group, box(170, 4, 70), '#cfc7b6');
        put(o.group, box(150, 58, 42), '#a8342a', { win: 1 });
        put(o.group, xf(frustum(164, 56, 120, 18, 25), { y: 58 }), '#b8642c');
        put(o.group, xf(box(122, 4, 4), { y: 83 }), '#7a3d1c');
        rect(o, 0, 0, 172, 72, 4);
        rect(o, 0, 0, 166, 58, 87);
        return 87;
      });

      // ---------------------------------------------------------------
      // 8. Sun Yat-sen Memorial Hall: beige body, upturned yellow roof.
      // ---------------------------------------------------------------
      add('Sun Yat-sen Memorial Hall', (o) => {
        put(o.group, box(100, 18, 100), '#d6c9ae', { win: 1 });
        put(o.group, xf(frustum(104, 104, 124, 124, 12), { y: 18 }), '#d9a83a');
        rect(o, 0, 0, 126, 126, 30);
        return 30;
      });

      // ---------------------------------------------------------------
      // 9. Taipei Dome: low oval dome (165 x 135 m) on an elliptical base ring.
      // ---------------------------------------------------------------
      add('Taipei Dome', (o) => {
        put(o.group, xf(cyl(150, 150, 8, 32), { sx: 165 / 150, sz: 135 / 150 }), '#bdbdb8');
        put(o.group, xf(dome(165, 62, 28), { sz: 135 / 165, y: 8 }), '#d9d9d4');
        circle(o, 0, 0, 166, 70);
        return 70;
      });

      // ---------------------------------------------------------------
      // 10. Taipei Arena: round arena with a shallow roof.
      // ---------------------------------------------------------------
      add('Taipei Arena', (o) => {
        put(o.group, cyl(72, 72, 28, 32), '#c9c9c5', { win: 1 });
        put(o.group, xf(dome(72, 9, 24), { y: 28 }), '#aeb2b6');
        circle(o, 0, 0, 74, 37);
        return 37;
      });

      // ---------------------------------------------------------------
      // 11. Miramar Ferris Wheel (100 m): mall box + a vertical wheel facing
      //     +-z that turns (animate), with 24 upright instanced gondolas.
      // ---------------------------------------------------------------
      add('Miramar Ferris Wheel', (o) => {
        const HX = 60, HY = 52, HZ = -40, R = 46, N = 24;
        put(o.group, xf(box(140, 28, 100), { x: -40, z: 30 }), '#c9b9a6', { win: 1 });
        // wheel: rim + 16 spokes + hub, one mesh in a rotating sub-group
        const parts = [torus(R, 1.3, 6, 56)];
        for (let i = 0; i < 16; i++) parts.push(xf(box(1.2, R, 1.2), { rz: i * PI / 8 }));
        parts.push(xf(xf(cyl(4, 4, 6, 12), { y: -3 }), { rx: PI / 2 }));
        const wheel = new THREE.Group();
        wheel.name = 'wheel';
        wheel.position.set(HX, HY, HZ);
        o.group.add(wheel);
        put(wheel, parts, '#d9d2c4');
        // A-frame supports: 2 slanted legs per side, from the ground to the hub, offset +-3 in z
        const legs = [];
        const spread = 22, len = Math.hypot(spread, HY), tilt = Math.atan2(spread, HY);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) legs.push(xf(box(2, len, 2), { rz: sx * tilt, x: HX + sx * spread, z: HZ + sz * 3 }));
        }
        put(o.group, legs, '#9aa0a6');
        // gondolas: one InstancedMesh, always upright, hanging below the rim
        const inst = new THREE.InstancedMesh(xf(box(3, 3.4, 2.4), { y: -1.7 }), H.mat('#e8e2d6'), N);
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        inst.frustumCulled = false;
        inst.castShadow = true; inst.receiveShadow = true;
        o.group.add(inst);
        const m4 = new THREE.Matrix4();
        let angle = 0;
        function placeGondolas() {
          for (let i = 0; i < N; i++) {
            const a = angle + (2 * PI * i) / N;
            m4.makeTranslation(HX + R * Math.cos(a), HY + R * Math.sin(a) - 2.5, HZ);
            inst.setMatrixAt(i, m4);
          }
          inst.instanceMatrix.needsUpdate = true;
        }
        placeGondolas();
        o.rec.animate = function (dt) {
          dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
          angle += 0.05 * dt;
          if (angle > 2 * PI) angle -= 2 * PI;
          wheel.rotation.z = angle;
          placeGondolas();
        };
        circle(o, HX, HZ, 52, 100);
        rect(o, -40, 30, 142, 102, 28);
        return 100;
      });

      // ---------------------------------------------------------------
      // 12. Nangang Exhibition Center: two big halls with white slab roofs.
      // ---------------------------------------------------------------
      add('Nangang Exhibition Center', (o) => {
        const bodies = [xf(box(220, 34, 170), { x: 110 }), xf(box(180, 28, 130), { x: -130, z: 60 }), xf(box(60, 6, 40), { x: 110, y: 38 })];
        const slabs = [xf(box(224, 4, 174), { x: 110, y: 34 }), xf(box(184, 4, 134), { x: -130, y: 28, z: 60 })];
        put(o.group, bodies, '#b8bcc0', { win: 1 });
        put(o.group, slabs, '#e4e4e0');
        rect(o, 110, 0, 226, 176, 44);
        rect(o, -130, 60, 186, 136, 32);
        return 44;
      });

      // ---------------------------------------------------------------
      // 13. New Taipei City Hall (140 m) and Banqiao Mega Tower (200 m):
      //     glass boxes with stepped crowns, two separate records.
      // ---------------------------------------------------------------
      add('New Taipei City Hall', (o) => {
        put(o.group, [box(62, 136, 46), xf(box(30, 4, 20), { y: 136 })], '#7f9aa8', { glass: true, win: 2 });
        rect(o, 0, 0, 66, 50, 140);
        return 140;
      });

      add('Banqiao Mega Tower', (o) => {
        put(o.group, [box(52, 190, 52), xf(box(40, 6, 40), { y: 190 }), xf(box(26, 4, 26), { y: 196 })], '#5e7a8c', { glass: true, win: 2 });
        rect(o, 0, 0, 56, 56, 200);
        return 200;
      });

      return records;
    };
  })();

  // ================= PART 3/3: core =================
  (function () {
    'use strict';
    const FS = window.FS;
    const makeHelpers = FS.__cityHelpers, makeLandmarks = FS.__cityLandmarks;
    delete FS.__cityHelpers; delete FS.__cityLandmarks; delete FS.__cityPatchWindows;

    const CFG = FS.CONFIG, G = FS.geo;
    const clamp = G.clamp, smoothstep = G.smoothstep, D2R = Math.PI / 180;
    const SEED = 20260926;
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

    const city = (FS.city = {
      landmarks: [],
      stats: {},
      init, getObstacleTop, update, setQuality,
    });

    // ---------------------------------------------------------------
    // Quality budgets (instances). l2/l1 = number of blocks laid out with full lots / edge strips;
    // the rest get 1-2 mass boxes until `cap` is hit (blocks are processed nearest-to-focus first).
    // ---------------------------------------------------------------
    // Per-block cost is roughly 34 instances at L2 (lots + rooftop sheds/tanks/stair heads), 5 at L1, 1 at L0.
    // `clutter` scales the rooftop-item probabilities.
    const QUALITY = {
      low: { cap: 30000, l2: 350, l1: 900, trees: 1500, outer: 0.5, clutter: 0.6 },
      medium: { cap: 70000, l2: 1000, l1: 2400, trees: 4000, outer: 1, clutter: 1.0 },
      high: { cap: 130000, l2: 2200, l1: 4500, trees: 9000, outer: 1, clutter: 1.15 },
    };
    const TILE = 2500, TREE_TILE = 5000;

    // Focus points for level-of-detail priority (where the player spends time): distance / r
    const FOCUS = [
      { x: 3277, z: -2145, r: 1.0 },   // Songshan airport (spawn)
      { x: 4488, z: 1780, r: 1.0 },    // Xinyi / Taipei 101
      { x: -303, z: 243, r: 0.9 },     // Taipei Main Station
      { x: -5546, z: 4146, r: 0.55 },  // Banqiao
      { x: 6555, z: -2875, r: 0.55 },  // Neihu
    ];

    // ---------------------------------------------------------------
    // Districts: rotated rectangles with their own grid orientation and block size (world metres).
    // rot > 0 rotates the grid's north axis clockwise (toward east) when viewed north-up.
    // artX/artZ: explicit arterial positions (world coords) for the axis-aligned central grid;
    // other districts get an arterial every `every` blocks. rivers: [name, side] constraints where
    // side = +1 / -1 is right / left of the river polyline walked from its first to its last point.
    // ---------------------------------------------------------------
    const DISTRICT_DEFS = [
      { name: 'Central Taipei', cx: 1450, cz: 300, w: 8300, h: 6600, rot: 0, bu: 130, bv: 90, minor: 11, art: 34,
        // N-S: Zhonghua, Chongqing, Zhongshan N, Xinsheng, Jianguo, Fuxing, Dunhua, Guangfu, Keelung Rd, Songshan Rd
        artX: [-1160, -656, 252, 1311, 1714, 2420, 2925, 3782, 4285, 5100],
        // E-W: Minzu, Minquan, Minsheng, Nanjing, Civic Blvd, Zhongxiao, Ren'ai, Xinyi, Heping, Xinhai
        artZ: [-1880, -1382, -885, -221, 608, 940, 1350, 1824, 2687, 3207],
        rivers: [['Keelung River', -1], ['Xindian River', 1], ['Tamsui River', 1]] },
      { name: 'Shilin', cx: 504, cz: -4644, w: 4400, h: 3600, rot: -15, bu: 120, bv: 85, rivers: [['Keelung River', 1], ['Tamsui River', 1]] },
      { name: 'Tianmu', cx: 1008, cz: -7187, w: 2800, h: 3000, rot: -5, bu: 120, bv: 90, rivers: [['Keelung River', 1]] },
      { name: 'Beitou', cx: -2017, cz: -8625, w: 4400, h: 5200, rot: -30, bu: 110, bv: 80, rivers: [['Tamsui River', 1], ['Keelung River', 1]] },
      { name: 'Neihu', cx: 6555, cz: -2875, w: 6400, h: 3200, rot: 10, bu: 125, bv: 90, rivers: [['Keelung River', 1]] },
      { name: 'Nangang', cx: 9076, cz: 0, w: 5200, h: 2600, rot: 8, bu: 120, bv: 90, rivers: [['Keelung River', -1]] },
      { name: 'Sanchong-Luzhou', cx: -3328, cz: -2433, w: 4200, h: 6400, rot: -20, bu: 110, bv: 80, rivers: [['Tamsui River', -1], ['Dahan River', -1]] },
      { name: 'Banqiao', cx: -5849, cz: 4202, w: 5800, h: 4600, rot: 25, bu: 120, bv: 85, rivers: [['Dahan River', 1], ['Xindian River', -1]] },
      { name: 'Zhonghe-Yonghe', cx: -1513, cz: 5197, w: 5800, h: 4200, rot: 35, bu: 80, bv: 60, minor: 9, art: 28, jitter: 0.22, every: 6,
        rivers: [['Xindian River', -1], ['Dahan River', 1]] },
      { name: 'Xinzhuang', cx: -8068, cz: 1106, w: 5600, h: 4400, rot: -30, bu: 115, bv: 85, rivers: [['Dahan River', -1], ['Tamsui River', -1]] },
      { name: 'Tucheng', cx: -8068, cz: 8293, w: 4400, h: 3600, rot: 30, bu: 115, bv: 85, rivers: [['Dahan River', 1]] },
      { name: 'Wenshan', cx: 4034, cz: 6634, w: 5200, h: 4200, rot: 15, bu: 115, bv: 85, rivers: [['Xindian River', 1]] },
      { name: 'Xindian', cx: 1513, cz: 9067, w: 4400, h: 5000, rot: 20, bu: 115, bv: 85, rivers: [['Xindian River', 1]] },
    ];
    const FALLBACK_DEF = { name: 'basin grid', cx: 0, cz: 0, w: 28000, h: 28000, rot: 0, bu: 130, bv: 90 };

    // Landmark sites (no-build rectangles centred on the config landmark; plaza = painted pale grey)
    const SITES = [
      { lm: 'Taipei 101', w: 260, d: 260, plaza: true },
      { lm: 'Nan Shan Plaza', w: 120, d: 120, plaza: true },
      { lm: 'Shin Kong Life Tower', w: 90, d: 90 },
      { lm: 'Taipei Main Station', w: 460, d: 220, plaza: true },
      { lm: 'Presidential Office', w: 320, d: 260, plaza: true },
      { lm: 'Grand Hotel', w: 260, d: 200 },
      { lm: 'Taipei Dome', w: 380, d: 340, plaza: true },
      { lm: 'Taipei Arena', w: 200, d: 200, plaza: true },
      { lm: 'Miramar Ferris Wheel', w: 260, d: 220 },
      { lm: 'Nangang Exhibition Center', w: 520, d: 420, plaza: true },
      { lm: 'New Taipei City Hall', w: 110, d: 110, plaza: true },
      { lm: 'Banqiao Mega Tower', w: 110, d: 110 },
    ];
    // Extra plazas (axis-aligned, relative to a landmark or absolute)
    const PLAZA_DEFS = [
      { lm: 'CKS Memorial Hall', dx: -60, dz: 0, w: 280, d: 200 },        // Liberty Square
      { lm: 'Sun Yat-sen Memorial Hall', dx: 0, dz: 120, w: 260, d: 90 }, // forecourt
      { lm: 'Presidential Office', dx: 360, dz: 0, w: 400, d: 44 },       // Ketagalan Boulevard
      { x: 4387, z: 1382, w: 300, d: 200 },                                // Xinyi civic plaza (City Hall square)
    ];

    // Elevated expressways painted as lighter ribbons ([lat, lon] polylines, width m)
    const EXPRESSWAY_DEFS = [
      { name: 'National Freeway 1 (Sun Yat-sen Freeway)', w: 36, pts: [[25.065, 121.660], [25.060, 121.635], [25.058, 121.615], [25.065, 121.598], [25.072, 121.578],
        [25.074, 121.565], [25.0745, 121.552], [25.076, 121.535], [25.077, 121.525], [25.072, 121.515], [25.069, 121.500], [25.072, 121.485], [25.078, 121.468],
        [25.086, 121.445], [25.086, 121.420], [25.070, 121.385], [25.050, 121.345], [25.030, 121.300], [25.010, 121.250]] },
      { name: 'National Freeway 3', w: 34, pts: [[25.055, 121.640], [25.035, 121.615], [25.010, 121.590], [24.995, 121.565], [24.985, 121.535], [24.990, 121.500],
        [24.995, 121.470], [24.985, 121.440], [24.975, 121.400], [24.960, 121.360]] },
      { name: 'Civic Boulevard', w: 30, pts: [[25.0445, 121.508], [25.0445, 121.567]] },
      { name: 'Jianguo Elevated Road', w: 26, pts: [[25.067, 121.537], [25.021, 121.537]] },
      { name: 'Xinsheng Elevated Road', w: 24, pts: [[25.064, 121.533], [25.030, 121.533]] },
      { name: 'Provincial Highway 64', w: 28, pts: [[25.000, 121.440], [25.020, 121.455], [25.040, 121.462], [25.060, 121.470], [25.075, 121.475]] },
    ];

    // Bridges: name, lat, lon, deck width (m), style
    const BRIDGE_DEFS = [
      ['Taipei Bridge', 25.058, 121.505, 30], ['Zhongxiao Bridge', 25.049, 121.494, 28], ['Huajiang Bridge', 25.030, 121.492, 26],
      ['Zhongzheng Bridge', 25.020, 121.518, 22], ['Fuhe Bridge', 25.008, 121.532, 22], ['Dazhi Bridge', 25.073, 121.556, 26],
      ['Minquan Bridge', 25.058, 121.568, 24], ['MacArthur Bridge', 25.061, 121.566, 24], ['Zhongshan (Yuanshan) Bridge', 25.072, 121.523, 26],
      ['Guandu Bridge', 25.118, 121.459, 26, 'arch'], ['Zhongxing Bridge', 25.066, 121.500, 24], ['Chongyang Bridge', 25.085, 121.498, 24],
    ];

    // Towns outside the inner rect: sparse boxes + grey ground texture
    const TOWN_DEFS = [
      { name: 'Taoyuan', lat: 24.993, lon: 121.300, rx: 3600, rz: 3000, big: true },
      { name: 'Zhongli', lat: 24.965, lon: 121.225, rx: 3200, rz: 2800, big: true },
      { name: 'Bade', lat: 24.950, lon: 121.290, rx: 1800, rz: 1600 },
      { name: 'Guishan', lat: 25.000, lon: 121.340, rx: 2200, rz: 1800 },
      { name: 'Luzhu', lat: 25.050, lon: 121.290, rx: 1500, rz: 1300 },
      { name: 'Linkou', lat: 25.077, lon: 121.370, rx: 1800, rz: 1600 },
      { name: 'Yingge', lat: 24.955, lon: 121.350, rx: 1500, rz: 1300 },
      { name: 'Sanxia', lat: 24.934, lon: 121.370, rx: 1500, rz: 1300 },
      { name: 'Keelung', lat: 25.128, lon: 121.741, rx: 2600, rz: 2200, big: true },
      { name: 'Xizhi', lat: 25.065, lon: 121.660, rx: 2200, rz: 1600 },
    ];

    // ---------------------------------------------------------------
    // Palettes (sRGB hex -> linear rgb triplets, weighted)
    // ---------------------------------------------------------------
    function palette(list) {
      let total = 0; for (const e of list) total += e[1];
      let acc = 0;
      return list.map((e) => { const c = FS.color(e[0]); acc += e[1] / total; return { r: c.r, g: c.g, b: c.b, cum: acc }; });
    }
    function pick(pal, rnd) { const r = rnd(); for (let i = 0; i < pal.length; i++) if (r <= pal[i].cum) return pal[i]; return pal[pal.length - 1]; }
    let PAL_LOW, PAL_GLASS, PAL_SHED, PAL_TANK, PAL_STAIR, PAL_CAMPUS, PAL_TREE, PAL_OUTER;
    function setupPalettes() {
      // Taipei low-rise walls: weathered grey-beige tile, dirty concrete, faded tile, dark stained concrete,
      // brownish tile, a little pinkish-grey and only a small share of off-white (judged at exposure 0.85)
      PAL_LOW = palette([['#a89e8e', 28], ['#8f8a82', 22], ['#b3ada1', 15], ['#75716a', 14], ['#8d7b68', 11], ['#9a8f88', 4], ['#c4beb2', 6]]);
      PAL_GLASS = palette([['#4d6070', 35], ['#5e7a7c', 30], ['#6f8f8a', 20], ['#3f5566', 15]]);
      // rooftop sheds: rust-brown / silver corrugated / dark grey / blue-grey
      PAL_SHED = palette([['#7d4f33', 30], ['#9ba0a3', 30], ['#5f5e5a', 25], ['#6e7a85', 15]]);
      // water tanks: stainless / FRP off-white / dark plastic; stair heads: concrete grey
      PAL_TANK = palette([['#b5b8ba', 45], ['#d3cdb6', 35], ['#5a5a58', 20]]);
      PAL_STAIR = palette([['#7a7772', 60], ['#68665f', 40]]);
      PAL_CAMPUS = palette([['#c9c1b1', 50], ['#b8b3a7', 50]]);
      PAL_TREE = palette([['#2f5a2a', 25], ['#3b6b30', 30], ['#476f34', 20], ['#2a4d27', 15], ['#55793a', 10]]);
      PAL_OUTER = palette([['#a89e8e', 30], ['#8f8a82', 30], ['#9a968c', 25], ['#75716a', 15]]);
    }

    // Ground paint colours
    const C_ASPHALT = '#4a4845', C_ARTERIAL = '#6b6966', C_CENTER = 'rgba(228,222,206,0.55)', C_LANE = '#57544f', C_PLAZA = '#cfcac0',
      C_EXPRESS = '#7b7976', C_PARK = '#5a8a46', C_CAMPUS = '#5f8a4c', C_CAMPUS_BLD = '#d9d3c6', C_PATH = 'rgba(214,206,186,0.7)';
    const TONES = ['#9c9588', '#a19a8b', '#a69f91', '#aaa397', '#aea89a', '#b1a99b', '#a39d92', '#a89c8e', '#9e9990', '#aba596'];
    const TOWN_TONES = ['#9a968c', '#a09c92', '#8f8b83', '#a6a198'];
    const MOTTLE = ['rgba(38,86,34,0.55)', 'rgba(108,150,72,0.45)', 'rgba(52,104,44,0.5)', 'rgba(126,160,84,0.35)'];
    function mixHex(a, b, t) {
      const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
      const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
      return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
    }
    const TONES_OUTER = TONES.map((t) => mixHex(t, C_ASPHALT, 0.22));

    // ---------------------------------------------------------------
    // World access with fallbacks (module still builds a city without FS.world)
    // ---------------------------------------------------------------
    const W = { ground: null, water: null, paint: null, real: false };
    function riverDepth(x, z) { // > 0 inside a config river (fallback water test)
      let best = -1e9;
      for (const r of CFG.rivers) {
        const p = r.points;
        for (let i = 0; i + 1 < p.length; i++) {
          const ax = p[i].x, az = p[i].z, dx = p[i + 1].x - ax, dz = p[i + 1].z - az;
          const l2 = dx * dx + dz * dz; let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const w = p[i].w + (p[i + 1].w - p[i].w) * t;
          const d = w * 0.5 - Math.hypot(x - (ax + dx * t), z - (az + dz * t));
          if (d > best) best = d;
        }
      }
      return best;
    }
    function bindWorld() {
      const w = FS.world;
      const hasH = !!(w && typeof w.getHeight === 'function');
      const hasW = !!(w && typeof w.isWater === 'function');
      W.real = hasH;
      W.ground = hasH ? function (x, z) { const h = w.getHeight(x, z); return h > 0 ? h : 0; } : function (x, z) { return riverDepth(x, z) > 0 ? 0 : 5; };
      W.water = hasW ? function (x, z) { return !!w.isWater(x, z); } : function (x, z) { return riverDepth(x, z) > 0; };
      W.paint = (w && typeof w.paintGround === 'function') ? function (fn) { w.paintGround(fn); } : null;
    }

    // ---------------------------------------------------------------
    // Density field on a 50 m grid over the inner rect: elevation, slope, water distance, centre falloff.
    // ---------------------------------------------------------------
    const R = CFG.innerRect;
    const GRID = { cell: 50, x0: R.x0, z0: R.z0, nx: 0, nz: 0, hgt: null, wat: null, wd: null, slp: null, dens: null };
    function gridIndex(x, z) {
      const i = Math.floor((x - GRID.x0) / GRID.cell), j = Math.floor((z - GRID.z0) / GRID.cell);
      if (i < 0 || j < 0 || i >= GRID.nx || j >= GRID.nz) return -1;
      return j * GRID.nx + i;
    }
    function gridSample(arr, x, z) {
      const fx = (x - GRID.x0) / GRID.cell - 0.5, fz = (z - GRID.z0) / GRID.cell - 0.5;
      const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, nx = GRID.nx, nz = GRID.nz;
      const i0 = clamp(i, 0, nx - 1), i1 = clamp(i + 1, 0, nx - 1), j0 = clamp(j, 0, nz - 1), j1 = clamp(j + 1, 0, nz - 1);
      const a = arr[j0 * nx + i0], b = arr[j0 * nx + i1], c = arr[j1 * nx + i0], d = arr[j1 * nx + i1];
      return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
    }
    function buildGrid() {
      const c = GRID.cell;
      GRID.nx = Math.ceil((R.x1 - R.x0) / c); GRID.nz = Math.ceil((R.z1 - R.z0) / c);
      const nx = GRID.nx, nz = GRID.nz, n = nx * nz;
      const hgt = (GRID.hgt = new Float32Array(n)), wat = (GRID.wat = new Uint8Array(n)), wd = (GRID.wd = new Float32Array(n));
      const slp = (GRID.slp = new Float32Array(n)), dens = (GRID.dens = new Float32Array(n));
      for (let j = 0; j < nz; j++) {
        const z = R.z0 + (j + 0.5) * c;
        for (let i = 0; i < nx; i++) {
          const x = R.x0 + (i + 0.5) * c, k = j * nx + i;
          const h = W.ground(x, z);
          hgt[k] = h; wat[k] = (h <= 0.01 || W.water(x, z)) ? 1 : 0;
        }
      }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const hx0 = hgt[k - (i > 0 ? 1 : 0)], hx1 = hgt[k + (i < nx - 1 ? 1 : 0)], hz0 = hgt[k - (j > 0 ? nx : 0)], hz1 = hgt[k + (j < nz - 1 ? nx : 0)];
        slp[k] = Math.hypot(hx1 - hx0, hz1 - hz0) / (2 * c);
      }
      // chamfer distance transform to water (in cells), capped at 40 cells
      const INF = 1e9;
      for (let k = 0; k < n; k++) wd[k] = wat[k] ? 0 : INF;
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i; let d = wd[k];
        if (i > 0) d = Math.min(d, wd[k - 1] + 1);
        if (j > 0) { d = Math.min(d, wd[k - nx] + 1); if (i > 0) d = Math.min(d, wd[k - nx - 1] + 1.4142); if (i < nx - 1) d = Math.min(d, wd[k - nx + 1] + 1.4142); }
        wd[k] = d;
      }
      for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i; let d = wd[k];
        if (i < nx - 1) d = Math.min(d, wd[k + 1] + 1);
        if (j < nz - 1) { d = Math.min(d, wd[k + nx] + 1); if (i < nx - 1) d = Math.min(d, wd[k + nx + 1] + 1.4142); if (i > 0) d = Math.min(d, wd[k + nx - 1] + 1.4142); }
        wd[k] = d;
      }
      for (let k = 0; k < n; k++) wd[k] = Math.min(wd[k], 40) * c;
      const uc = CFG.urbanCenter;
      for (let j = 0; j < nz; j++) {
        const z = R.z0 + (j + 0.5) * c;
        for (let i = 0; i < nx; i++) {
          const x = R.x0 + (i + 0.5) * c, k = j * nx + i;
          if (wat[k]) { dens[k] = 0; continue; }
          const dc = Math.hypot(x - uc.x, z - uc.z);
          dens[k] = (1 - smoothstep(25, 120, hgt[k])) * (1 - smoothstep(0.15, 0.35, slp[k])) *
            (1 - smoothstep(uc.radius, uc.radius + 4000, dc)) * smoothstep(60, 140, wd[k]);
        }
      }
    }
    function insideInner(x, z) { return x >= R.x0 && x < R.x1 && z >= R.z0 && z < R.z1; }

    // No-build areas: parks, airports, landmark sites, plazas (rotated rects: u = dx*c + dz*s, v = -dx*s + dz*c)
    const NOBUILD = [];
    function inRotRect(x, z, r) {
      const dx = x - r.cx, dz = z - r.cz;
      const u = dx * r.c + dz * r.s, v = -dx * r.s + dz * r.c;
      return u > -r.hw && u < r.hw && v > -r.hh && v < r.hh;
    }
    function noBuildAt(x, z) { for (let i = 0; i < NOBUILD.length; i++) if (inRotRect(x, z, NOBUILD[i])) return NOBUILD[i]; return null; }
    function lmByName(name) { for (const l of CFG.landmarks) if (l.name === name) return l; return null; }
    let PLAZAS = [], EXPRESSWAYS = [];
    function setupNoBuild() {
      NOBUILD.length = 0;
      for (const p of CFG.parks) {
        const r = (p.rot || 0) * D2R;
        NOBUILD.push({ cx: p.x, cz: p.z, c: Math.cos(r), s: Math.sin(r), hw: p.w / 2, hh: p.h / 2, kind: p.campus ? 'campus' : 'park', ref: p });
      }
      for (const a of CFG.airports) {
        const rw = a.runways[0], d = G.headingToDir(rw.heading);
        if (a.icao === 'RCSS') NOBUILD.push({ cx: rw.cx, cz: rw.cz, c: d.x, s: d.z, hw: 1700, hh: 450, kind: 'airport' });
        else NOBUILD.push({ cx: a.x, cz: a.z, c: d.x, s: d.z, hw: 2500, hh: 1400, kind: 'airport' });
      }
      for (const s of SITES) {
        const l = lmByName(s.lm); if (!l) continue;
        NOBUILD.push({ cx: l.x, cz: l.z, c: 1, s: 0, hw: s.w / 2, hh: s.d / 2, kind: 'site', plaza: !!s.plaza });
      }
      PLAZAS = [];
      for (const p of PLAZA_DEFS) {
        let x = p.x, z = p.z;
        if (p.lm) { const l = lmByName(p.lm); if (!l) continue; x = l.x + p.dx; z = l.z + p.dz; }
        const r = { cx: x, cz: z, c: 1, s: 0, hw: p.w / 2, hh: p.d / 2, kind: 'plaza', plaza: true };
        NOBUILD.push(r); PLAZAS.push(r);
      }
      EXPRESSWAYS = EXPRESSWAY_DEFS.map((e) => ({ name: e.name, w: e.w, pts: e.pts.map(([lat, lon]) => G.toWorld(lat, lon)) }));
    }
    function density(x, z) {
      if (!insideInner(x, z)) return 0;
      const d = gridSample(GRID.dens, x, z);
      if (d <= 0) return 0;
      return noBuildAt(x, z) ? 0 : d;
    }
    // Direct evaluation outside the inner rect (relative to a town's base elevation)
    function densityOuter(x, z, h0) {
      const h = W.ground(x, z);
      if (h <= 0.01 || W.water(x, z)) return 0;
      for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; if (W.water(x + Math.cos(a) * 120, z + Math.sin(a) * 120)) return 0; }
      const sx = (W.ground(x + 60, z) - W.ground(x - 60, z)) / 120, sz = (W.ground(x, z + 60) - W.ground(x, z - 60)) / 120;
      const slope = Math.hypot(sx, sz);
      if (noBuildAt(x, z)) return 0;
      return (1 - smoothstep(h0 + 40, h0 + 120, h)) * (1 - smoothstep(0.12, 0.3, slope));
    }

    // ---------------------------------------------------------------
    // Districts and street lines
    // ---------------------------------------------------------------
    function riverByName(name) { for (const r of CFG.rivers) if (r.name === name) return r; return null; }
    function riverSide(river, x, z) {
      const p = river.points; let best = Infinity, cross = 0;
      for (let i = 0; i + 1 < p.length; i++) {
        const ax = p[i].x, az = p[i].z, dx = p[i + 1].x - ax, dz = p[i + 1].z - az;
        const l2 = dx * dx + dz * dz; let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z, dd = qx * qx + qz * qz;
        if (dd < best) { best = dd; cross = dx * (z - az) - dz * (x - ax); }
      }
      return cross >= 0 ? 1 : -1;
    }
    // street centre lines along one axis: [{p, w, art}]
    function makeLines(from, to, pitch, wMinor, wArt, every, explicit, rnd, jitter) {
      const out = [];
      const push = (p, art) => out.push({ p, w: art ? wArt : wMinor, art });
      if (explicit && explicit.length) {
        const arts = explicit.filter((p) => p > from && p < to).sort((a, b) => a - b);
        if (arts.length) {
          const lead = [];
          for (let p = arts[0] - pitch; p > from; p -= pitch) lead.push(p);
          for (let i = lead.length - 1; i >= 0; i--) push(lead[i], false);
          for (let a = 0; a < arts.length; a++) {
            push(arts[a], true);
            if (a + 1 < arts.length) {
              const gap = arts[a + 1] - arts[a], n = Math.max(1, Math.round(gap / pitch));
              for (let k = 1; k < n; k++) push(arts[a] + gap * k / n, false);
            } else {
              for (let q = arts[a] + pitch; q < to; q += pitch) push(q, false);
            }
          }
          return out;
        }
      }
      const off = rnd() * pitch, phase = Math.floor(rnd() * every);
      let i = 0;
      for (let p = from + off; p < to; p += pitch, i++) {
        const q = jitter ? p + (rnd() - 0.5) * 2 * jitter * pitch : p;
        push(q, every > 0 && (i % every) === phase);
      }
      return out;
    }
    function setupDistrict(def, idx, rnd) {
      const d = Object.assign({}, def);
      d.idx = idx; d.r = d.rot * D2R; d.c = Math.cos(d.r); d.s = Math.sin(d.r);
      d.minor = d.minor || 11; d.art = d.art || 34; d.every = d.every || 5;
      d.riverSides = (d.rivers || []).map(([name, side]) => ({ river: riverByName(name), side })).filter((r) => r.river);
      d.uL = makeLines(-d.w / 2, d.w / 2, d.bu + d.minor, d.minor, d.art, d.every, d.artX ? d.artX.map((x) => x - d.cx) : null, rnd, d.jitter);
      d.vL = makeLines(-d.h / 2, d.h / 2, d.bv + d.minor, d.minor, d.art, d.every, d.artZ ? d.artZ.map((z) => z - d.cz) : null, rnd, d.jitter);
      d.blocks = [];
      return d;
    }
    function districtContains(d, x, z) {
      const dx = x - d.cx, dz = z - d.cz;
      const u = dx * d.c + dz * d.s, v = -dx * d.s + dz * d.c;
      if (u < -d.w / 2 || u > d.w / 2 || v < -d.h / 2 || v > d.h / 2) return false;
      for (const rs of d.riverSides) if (riverSide(rs.river, x, z) !== rs.side) return false;
      return true;
    }
    let districts = [], fallback = null;
    function districtAt(x, z) {
      for (let i = 0; i < districts.length; i++) if (districtContains(districts[i], x, z)) return i;
      return -1;
    }
    function hash3(a, b, c) { return (Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791) ^ SEED) >>> 0; }

    // CBD clusters
    let CBDS = [];
    function cbdAt(x, z) {
      let best = null, bestP = 0;
      for (const c of CBDS) {
        const d = Math.hypot(x - c.x, z - c.z);
        if (d >= c.radius) continue;
        const p = c.density * 0.18 * (1 - smoothstep(c.radius * 0.5, c.radius, d));
        if (p > bestP) { bestP = p; best = c; }
      }
      return best ? { p: bestP, minH: best.minH, maxH: best.maxH } : null;
    }

    // ---------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------
    let blocks = [];
    function collectBlocks() {
      blocks = [];
      const all = districts.concat([fallback]);
      for (const d of all) {
        const isFb = d === fallback;
        d.blocks = [];
        for (let i = 0; i + 1 < d.uL.length; i++) {
          const L = d.uL[i], Rr = d.uL[i + 1];
          const u0 = L.p + L.w / 2, u1 = Rr.p - Rr.w / 2;
          if (u1 - u0 < 24) continue;
          for (let j = 0; j + 1 < d.vL.length; j++) {
            const T = d.vL[j], B = d.vL[j + 1];
            const v0 = T.p + T.w / 2, v1 = B.p - B.w / 2;
            if (v1 - v0 < 24) continue;
            const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
            const wx = d.cx + uc * d.c - vc * d.s, wz = d.cz + uc * d.s + vc * d.c;
            if (!insideInner(wx, wz)) continue;
            const owner = districtAt(wx, wz);
            if ((isFb ? -1 : d.idx) !== owner) continue;
            const dens = density(wx, wz);
            if (dens < 0.04) continue;
            const seed = hash3(isFb ? 99 : d.idx, i, j);
            const rnd = FS.mulberry32(seed);
            if (rnd() > dens) continue;
            let prio = Infinity;
            for (const f of FOCUS) { const p = Math.hypot(wx - f.x, wz - f.z) / f.r; if (p < prio) prio = p; }
            const b = { d, u0, u1, v0, v1, wx, wz, dens, seed, prio, tone: Math.floor(rnd() * TONES.length),
              wN: T.w, wS: B.w, wW: L.w, wE: Rr.w, aN: T.art, aS: B.art, aW: L.art, aE: Rr.art, level: 0, lanes: null };
            blocks.push(b); d.blocks.push(b);
          }
        }
      }
      blocks.sort((a, b) => a.prio - b.prio);
    }

    // ---------------------------------------------------------------
    // Obstacle grids (inner 50 m cells, outer 100 m cells over the whole world)
    // ---------------------------------------------------------------
    const OBS = { cell: 50, x0: R.x0, z0: R.z0, x1: R.x1, z1: R.z1, nx: 0, nz: 0, top: null };
    const OBS2 = { cell: 100, x0: -CFG.worldHalfSize, z0: -CFG.worldHalfSize, x1: CFG.worldHalfSize, z1: CFG.worldHalfSize, nx: 0, nz: 0, top: null };
    function initObstacleGrids() {
      for (const g of [OBS, OBS2]) {
        g.nx = Math.ceil((g.x1 - g.x0) / g.cell); g.nz = Math.ceil((g.z1 - g.z0) / g.cell);
        if (!g.top) g.top = new Float32Array(g.nx * g.nz);
        g.top.fill(-Infinity);
      }
    }
    function markGrid(g, x0, z0, x1, z1, top) {
      if (x1 < g.x0 || x0 >= g.x1 || z1 < g.z0 || z0 >= g.z1) return;
      const i0 = Math.max(0, Math.floor((x0 - g.x0) / g.cell)), i1 = Math.min(g.nx - 1, Math.floor((x1 - g.x0) / g.cell));
      const j0 = Math.max(0, Math.floor((z0 - g.z0) / g.cell)), j1 = Math.min(g.nz - 1, Math.floor((z1 - g.z0) / g.cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const k = j * g.nx + i; if (top > g.top[k]) g.top[k] = top; }
    }
    function obsRect(x, z, w, d, rotY, top) {
      const c = Math.abs(Math.cos(rotY)), s = Math.abs(Math.sin(rotY));
      const hx = w * 0.5 * c + d * 0.5 * s, hz = w * 0.5 * s + d * 0.5 * c;
      markGrid(OBS, x - hx, z - hz, x + hx, z + hz, top);
      markGrid(OBS2, x - hx, z - hz, x + hx, z + hz, top);
    }
    function obsCircle(x, z, r, top) { markGrid(OBS, x - r, z - r, x + r, z + r, top); markGrid(OBS2, x - r, z - r, x + r, z + r, top); }
    const staticObs = []; // replayed after a quality rebuild
    function obsRectStatic(x, z, w, d, rotY, top) { staticObs.push([0, x, z, w, d, rotY, top]); obsRect(x, z, w, d, rotY, top); }
    function obsCircleStatic(x, z, r, top) { staticObs.push([1, x, z, r, top]); obsCircle(x, z, r, top); }
    function replayStaticObs() { for (const o of staticObs) { if (o[0] === 0) obsRect(o[1], o[2], o[3], o[4], o[5], o[6]); else obsCircle(o[1], o[2], o[3], o[4]); } }

    function getObstacleTop(x, z) {
      const g = (x >= OBS.x0 && x < OBS.x1 && z >= OBS.z0 && z < OBS.z1) ? OBS : OBS2;
      if (!g.top) return -Infinity;
      const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((z - g.z0) / g.cell);
      let best = -Infinity;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= g.nz) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if (ii < 0 || ii >= g.nx) continue;
          const v = g.top[jj * g.nx + ii]; if (v > best) best = v;
        }
      }
      return best;
    }

    // ---------------------------------------------------------------
    // Instance emission (buildings + trees), per tile
    // ---------------------------------------------------------------
    const STRIDE = 11; // x, y, z, rotY, sx, sy, sz, r, g, b, win
    const OUT = { tiles: new Map(), count: 0, cap: 0, sheds: 0, towers: 0 };
    const TREES = { tiles: new Map(), count: 0, cap: 0 };
    function tileFor(store, x, z, size) {
      const ti = Math.floor((x + CFG.worldHalfSize) / size), tj = Math.floor((z + CFG.worldHalfSize) / size);
      const key = ti * 256 + tj;
      let t = store.tiles.get(key);
      if (!t) { t = { a: [], n: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity }; store.tiles.set(key, t); }
      return t;
    }
    function pushInstance(store, t, x, y, z, rotY, sx, sy, sz, col, f, win) {
      t.a.push(x, y, z, rotY, sx, sy, sz, col.r * f, col.g * f, col.b * f, win);
      t.n++; store.count++;
      if (x < t.minX) t.minX = x; if (x > t.maxX) t.maxX = x; if (z < t.minZ) t.minZ = z; if (z > t.maxZ) t.maxZ = z;
      if (y < t.minY) t.minY = y; if (y + sy > t.maxY) t.maxY = y + sy;
    }
    // Base of a box: centre height on flat ground, lowest footprint corner on slopes; sunk so no gap shows downhill.
    function baseY(x, z, w, d) {
      let h = W.ground(x, z), sink = 1.0;
      const k = gridIndex(x, z);
      const slope = k >= 0 ? GRID.slp[k] : 0.05;
      if (slope > 0.012) {
        const hx = Math.max(w, d) * 0.55, hz = hx;
        h = Math.min(h, W.ground(x - hx, z - hz), W.ground(x + hx, z - hz), W.ground(x - hx, z + hz), W.ground(x + hx, z + hz));
        sink = 1.8;
      }
      if (h < 0.5) h = 0.5;
      return { y: h - sink, sink };
    }
    // Emits a box; returns its top (m MSL) or NaN when the budget is exhausted. baseOverride: explicit base y (rooftop sheds).
    function emitBox(x, z, w, d, h, rotY, col, f, win, baseOverride) {
      if (OUT.count >= OUT.cap) return NaN;
      let y, sy;
      if (baseOverride != null) { y = baseOverride; sy = h; }
      else { const b = baseY(x, z, w, d); y = b.y; sy = h + b.sink; }
      const t = tileFor(OUT, x, z, TILE);
      pushInstance(OUT, t, x, y, z, rotY, w, sy, d, col, f, win);
      const top = y + sy;
      obsRect(x, z, w, d, rotY, top);
      return top;
    }

    // Seeded per-lot floor count: 2-3 floor old shophouses (10 %), 4-6 (45 %), 7-9 (25 %), 10-12 (15 %), 13-16 (5 %);
    // arterial frontages skew taller. `mass` = whole-block boxes: no shophouses, capped at 9 floors.
    function lowHeight(rnd, arterial, mass) {
      const r = rnd();
      let floors;
      if (r < 0.10) floors = mass ? 4 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 2);
      else if (r < 0.55) floors = 4 + Math.floor(rnd() * 3);
      else if (r < 0.80) floors = 7 + Math.floor(rnd() * 3);
      else if (r < 0.95) floors = 10 + Math.floor(rnd() * 3);
      else floors = 13 + Math.floor(rnd() * 4);
      if (arterial && rnd() < 0.4) floors += 3;
      if (mass && floors > 9) floors = 9;
      return floors * 3.2 + 0.6;
    }

    // Lays out one block at the given level (2 = lots, 1 = edge strips, 0 = mass boxes)
    function layoutBlock(b, level, q) {
      const d = b.d, c = d.c, s = d.s, rotY = -d.r;
      const rnd = FS.mulberry32(b.seed ^ 0x9e3779b9);
      const cbd = cbdAt(b.wx, b.wz);
      const bw = b.u1 - b.u0, bd = b.v1 - b.v0;
      b.level = level;
      const clutter = q.clutter == null ? 1 : q.clutter;

      // rooftop item of size sw x sd x sh somewhere on the roof of the box centred at (x, z) (local frame u/v)
      function roofItem(x, z, w, dd, top, sw, sd, sh, pal) {
        if (sw > w - 1 || sd > dd - 1) return false;
        const du = (rnd() - 0.5) * (w - sw - 1), dv = (rnd() - 0.5) * (dd - sd - 1);
        const ok = !isNaN(emitBox(x + du * c - dv * s, z + du * s + dv * c, sw, sd, sh, rotY, pick(pal, rnd), 0.85 + rnd() * 0.15, 0, top - 0.3));
        if (ok) OUT.sheds++;
        return ok;
      }

      function put(u, v, w, dd, h, kind, art) {
        const x = d.cx + u * c - v * s, z = d.cz + u * s + v * c;
        let col, f, win;
        if (kind === 'tower') { col = pick(PAL_GLASS, rnd); f = 0.85 + rnd() * 0.2; win = 2; OUT.towers++; }
        else { col = pick(PAL_LOW, rnd); f = 0.70 + rnd() * 0.25; win = 1; }
        const top = emitBox(x, z, w, dd, h, rotY, col, f, win);
        if (isNaN(top)) return false;
        if (kind === 'low' && level === 2 && h < 45) {
          // rooftop clutter: corrugated shed (or a stair head), plus a water tank
          const shed = rnd() < 0.5 * clutter;
          if (shed) roofItem(x, z, w, dd, top, w * (0.3 + rnd() * 0.25), dd * (0.35 + rnd() * 0.3), 2.6 + rnd() * 1.2, PAL_SHED);
          else if (rnd() < 0.4 * clutter) roofItem(x, z, w, dd, top, 2.4 + rnd() * 1.2, 2.4 + rnd() * 1.2, 2.5 + rnd() * 0.6, PAL_STAIR);
          if (rnd() < 0.45 * clutter) roofItem(x, z, w, dd, top, 1.5 + rnd() * 0.8, 1.5 + rnd() * 0.8, 1.6 + rnd() * 0.7, PAL_TANK);
        }
        return true;
      }

      if (level === 0) {
        // one mass box per block, uneven insets so the far field doesn't read as a perfect grid
        const iW = 3 + rnd() * 7, iE = 3 + rnd() * 7, iN = 3 + rnd() * 6, iS = 3 + rnd() * 6;
        const tw = cbd && rnd() < cbd.p * 1.5;
        const h0 = tw ? cbd.minH + rnd() * (cbd.maxH - cbd.minH) : lowHeight(rnd, b.aN || b.aS, true);
        put((b.u0 + iW + b.u1 - iE) / 2, (b.v0 + iN + b.v1 - iS) / 2, bw - iW - iE, bd - iN - iS, h0, tw ? 'tower' : 'low');
        return;
      }

      let depthN = 0, depthS = 0;
      const rows = [
        { side: 0, fixed: b.v0, dir: 1, art: b.aN },
        { side: 1, fixed: b.v1, dir: -1, art: b.aS },
      ];
      if (level === 1) {
        for (const row of rows) {
          const depth = 14 + rnd() * 4, setback = 1 + rnd() * 2;
          let p = b.u0 + 3, end = b.u1 - 3;
          const nseg = bw > 90 ? 1 + Math.floor(rnd() * 3) : 1;
          for (let k = 0; k < nseg; k++) {
            const segEnd = k === nseg - 1 ? end : p + (end - p) * (0.35 + rnd() * 0.4);
            const tw = cbd && rnd() < cbd.p * 1.5;
            const h = tw ? cbd.minH + rnd() * (cbd.maxH - cbd.minH) : lowHeight(rnd, row.art);
            put((p + segEnd - 2) / 2, row.fixed + row.dir * (setback + depth / 2), segEnd - 2 - p, depth, h, tw ? 'tower' : 'low');
            p = segEnd + 2;
          }
          if (row.side === 0) depthN = setback + depth; else depthS = setback + depth;
        }
        const vs = b.v0 + depthN + 3, ve = b.v1 - depthS - 3;
        if (ve - vs > 24) {
          for (const col of [{ fixed: b.u0, dir: 1, art: b.aW }, { fixed: b.u1, dir: -1, art: b.aE }]) {
            const depth = 13 + rnd() * 4, setback = 1 + rnd() * 2;
            put(col.fixed + col.dir * (setback + depth / 2), (vs + ve) / 2, depth, ve - vs, lowHeight(rnd, col.art), 'low');
          }
        }
        return;
      }

      // level 2: individual lots (12-30 m frontages, a few townhouses merged per box)
      for (const row of rows) {
        let p = b.u0 + rnd() * 4;
        const end = b.u1 - rnd() * 4;
        let maxDepth = 0;
        while (end - p > 9) {
          const tower = !!(cbd && rnd() < cbd.p && end - p > 28);
          let front = tower ? 30 + rnd() * 20 : 12 + rnd() * 18;
          if (end - p - front < 9) front = end - p;
          const depth = tower ? Math.min(30 + rnd() * 15, bd * 0.45) : 12 + rnd() * 8;
          const setback = rnd() * 2, gap = rnd() < 0.5 ? 0 : 0.5 + rnd() * 1.5;
          const h = tower ? cbd.minH + rnd() * (cbd.maxH - cbd.minH) : lowHeight(rnd, row.art);
          if (!put(p + front / 2, row.fixed + row.dir * (setback + depth / 2), front - gap, depth, h, tower ? 'tower' : 'low')) return;
          if (setback + depth > maxDepth) maxDepth = setback + depth;
          p += front;
        }
        if (row.side === 0) depthN = maxDepth; else depthS = maxDepth;
      }
      const vs = b.v0 + depthN + 2, ve = b.v1 - depthS - 2;
      if (ve - vs > 12) {
        for (const col of [{ fixed: b.u0, dir: 1, art: b.aW }, { fixed: b.u1, dir: -1, art: b.aE }]) {
          let p = vs;
          while (ve - p > 9) {
            let front = 12 + rnd() * 18;
            if (ve - p - front < 9) front = ve - p;
            const depth = 12 + rnd() * 8, setback = rnd() * 2, gap = rnd() < 0.5 ? 0 : 0.5 + rnd() * 1.5;
            if (!put(col.fixed + col.dir * (setback + depth / 2), p + front / 2, depth, front - gap, lowHeight(rnd, col.art), 'low')) return;
            p += front;
          }
        }
      }
      // interior row along a back lane
      const iv0 = b.v0 + depthN + 6, iv1 = b.v1 - depthS - 6;
      if (iv1 - iv0 > 26 && bw > 70) {
        const vmid = (iv0 + iv1) / 2, depth = Math.min(26, iv1 - iv0 - 2);
        let p = b.u0 + 24 + rnd() * 4;
        const end = b.u1 - 24;
        while (end - p > 9) {
          let front = 14 + rnd() * 20;
          if (end - p - front < 9) front = end - p;
          const gap = rnd() < 0.5 ? 0 : 0.5 + rnd() * 1.5;
          if (!put(p + front / 2, vmid, front - gap, depth, lowHeight(rnd, false), 'low')) return;
          p += front;
        }
        b.lanes = { v0: vmid - depth / 2 - 4, v1: vmid + depth / 2 + 4 };
      }
    }

    function generateBuildings(q) {
      OUT.tiles.clear(); OUT.count = 0; OUT.cap = q.cap; OUT.sheds = 0; OUT.towers = 0;
      let n2 = 0, n1 = 0, n0 = 0;
      for (let i = 0; i < blocks.length; i++) {
        if (OUT.count >= OUT.cap) break;
        const b = blocks[i];
        const level = i < q.l2 ? 2 : i < q.l2 + q.l1 ? 1 : 0;
        if (level === 2) n2++; else if (level === 1) n1++; else n0++;
        layoutBlock(b, level, q);
      }
      city.stats.blocksL2 = n2; city.stats.blocksL1 = n1; city.stats.blocksL0 = n0;
    }

    // Campus buildings (sparse pale low blocks inside campus parks) — painted too
    let campusRects = [];
    function generateCampuses() {
      campusRects = [];
      for (const p of CFG.parks) {
        if (!p.campus) continue;
        const rnd = FS.mulberry32(hash3(7, Math.round(p.x), Math.round(p.z)));
        const cols = Math.floor(p.w / 110), rowsN = Math.floor(p.h / 95);
        for (let i = 0; i < cols; i++) for (let j = 0; j < rowsN; j++) {
          if (rnd() > 0.42) continue;
          const x = p.x - p.w / 2 + (i + 0.5) * (p.w / cols) + (rnd() - 0.5) * 20;
          const z = p.z - p.h / 2 + (j + 0.5) * (p.h / rowsN) + (rnd() - 0.5) * 20;
          const w = 36 + rnd() * 24, d = 15 + rnd() * 6, h = (3 + Math.floor(rnd() * 3)) * 3.6;
          const col = pick(PAL_CAMPUS, rnd);
          if (!isNaN(emitBox(x, z, w, d, h, 0, col, 0.9 + rnd() * 0.1, 1))) campusRects.push([x, z, w, d]);
        }
      }
    }

    // Outer towns (sparse boxes + painted grey cells)
    let townCells = [];
    function generateTowns(q) {
      townCells = [];
      const rnd = FS.mulberry32(hash3(11, 22, 33));
      for (const t of TOWN_DEFS) {
        const p = G.toWorld(t.lat, t.lon);
        const h0 = W.ground(p.x, p.z);
        const rot = (rnd() - 0.5) * 60 * D2R, c = Math.cos(rot), s = Math.sin(rot);
        const cell = 200;
        for (let dz = -t.rz; dz < t.rz; dz += cell) for (let dx = -t.rx; dx < t.rx; dx += cell) {
          const e = (dx / t.rx) * (dx / t.rx) + (dz / t.rz) * (dz / t.rz);
          if (e > 1) continue;
          const x = p.x + dx + cell / 2, z = p.z + dz + cell / 2;
          if (insideInner(x, z)) continue;
          const dens = densityOuter(x, z, h0) * (1 - smoothstep(0.45, 1.0, e));
          if (dens <= 0.02) continue;
          if (rnd() < 0.75 * dens) townCells.push([x, z, cell - 18, Math.floor(rnd() * TOWN_TONES.length)]);
          if (rnd() < 0.55 * dens * q.outer) {
            const bw = 40 + rnd() * 30, bd = 30 + rnd() * 20;
            const tall = t.big && rnd() < 0.08;
            const h = tall ? 30 + rnd() * 30 : 12 + rnd() * 12;
            const col = pick(tall ? PAL_GLASS : PAL_OUTER, rnd);
            const ox = (rnd() - 0.5) * 60, oz = (rnd() - 0.5) * 60;
            emitBox(x + ox * c - oz * s, z + ox * s + oz * c, bw, bd, h, -rot, col, 0.85 + rnd() * 0.15, tall ? 2 : 1);
          }
        }
      }
    }

    // Trees: parks, campuses and riverside strips
    function generateTrees(q) {
      TREES.tiles.clear(); TREES.count = 0; TREES.cap = q.trees;
      const rnd = FS.mulberry32(hash3(5, 6, 7));
      const uc = CFG.urbanCenter;
      const plan = [];
      for (const p of CFG.parks) plan.push({ park: p, n: Math.min(500, Math.round(p.w * p.h / (p.campus ? 900 : 600))) });
      let est = 0; for (const e of plan) est += e.n;
      let riverLen = 0;
      for (const r of CFG.rivers) for (let i = 0; i + 1 < r.points.length; i++) riverLen += Math.hypot(r.points[i + 1].x - r.points[i].x, r.points[i + 1].z - r.points[i].z);
      const step = 55;
      est += (riverLen / step) * 2 * 0.8;
      const scale = Math.min(2.2, q.trees / Math.max(1, est));
      function tree(x, z) {
        if (TREES.count >= TREES.cap) return;
        const y = W.ground(x, z);
        if (y <= 0.01 || W.water(x, z)) return;
        const nb = noBuildAt(x, z);
        if (nb && nb.kind !== 'park' && nb.kind !== 'campus') return;
        const sz = 4 + rnd() * 3.5, sy = sz * (0.7 + rnd() * 0.35);
        const t = tileFor(TREES, x, z, TREE_TILE);
        pushInstance(TREES, t, x, y - 0.3, z, rnd() * Math.PI, sz, sy, sz * (0.85 + rnd() * 0.3), pick(PAL_TREE, rnd), 0.8 + rnd() * 0.2, 0);
      }
      for (const e of plan) {
        const p = e.park, n = Math.round(e.n * scale), r = (p.rot || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
        for (let i = 0; i < n; i++) {
          const u = (rnd() - 0.5) * p.w, v = (rnd() - 0.5) * p.h;
          tree(p.x + u * c - v * s, p.z + u * s + v * c);
        }
      }
      const rstep = step / Math.max(0.2, scale);
      for (const r of CFG.rivers) {
        const p = r.points;
        for (let i = 0; i + 1 < p.length; i++) {
          const ax = p[i].x, az = p[i].z, dx = p[i + 1].x - ax, dz = p[i + 1].z - az, len = Math.hypot(dx, dz);
          const nx = -dz / len, nz = dx / len;
          for (let t = rnd() * rstep; t < len; t += rstep) {
            const w = p[i].w + (p[i + 1].w - p[i].w) * (t / len);
            const bx = ax + dx * (t / len), bz = az + dz * (t / len);
            if (Math.hypot(bx - uc.x, bz - uc.z) > uc.radius + 3000 || !insideInner(bx, bz)) continue;
            for (const side of [1, -1]) {
              if (rnd() < 0.2) continue;
              const off = w / 2 + 30 + rnd() * 80;
              tree(bx + nx * off * side, bz + nz * off * side);
            }
          }
        }
      }
    }

    // ---------------------------------------------------------------
    // Meshes from the tile stores
    // ---------------------------------------------------------------
    let unitBox = null, treeGeo = null, buildingMat = null, treeMat = null;
    const tmpColor = new THREE.Color();
    function createInstancedMesh(t, base, mat, withWin, margin) {
      const n = t.n;
      const g = base.clone();
      if (withWin) g.setAttribute('aWin', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
      const mesh = new THREE.InstancedMesh(g, mat, n);
      const M = mesh.instanceMatrix.array, a = t.a;
      const winArr = withWin ? g.attributes.aWin.array : null;
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE, m = i * 16;
        const rot = a[o + 3], sx = a[o + 4], sy = a[o + 5], sz = a[o + 6];
        const c = Math.cos(rot), s = Math.sin(rot);
        M[m] = sx * c; M[m + 1] = 0; M[m + 2] = -sx * s; M[m + 3] = 0;
        M[m + 4] = 0; M[m + 5] = sy; M[m + 6] = 0; M[m + 7] = 0;
        M[m + 8] = sz * s; M[m + 9] = 0; M[m + 10] = sz * c; M[m + 11] = 0;
        M[m + 12] = a[o]; M[m + 13] = a[o + 1]; M[m + 14] = a[o + 2]; M[m + 15] = 1;
        tmpColor.setRGB(a[o + 7], a[o + 8], a[o + 9]);
        mesh.setColorAt(i, tmpColor);
        if (winArr) winArr[i] = a[o + 10];
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const cx = (t.minX + t.maxX) / 2, cy = (t.minY + t.maxY) / 2, cz = (t.minZ + t.maxZ) / 2;
      const rad = 0.5 * Math.hypot(t.maxX - t.minX, t.maxY - t.minY, t.maxZ - t.minZ) + margin;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), rad);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      return mesh;
    }

    let scene = null, quality = 'medium', H = null, lmRecords = [];
    const dyn = { meshes: [] };
    function clearDynamic() {
      for (const m of dyn.meshes) { if (scene) scene.remove(m); if (m.geometry) m.geometry.dispose(); }
      dyn.meshes = [];
    }
    function buildDynamic(qName) {
      const q = QUALITY[qName] || QUALITY.medium;
      clearDynamic();
      initObstacleGrids(); replayStaticObs();
      generateBuildings(q);
      generateCampuses();
      generateTowns(q);
      generateTrees(q);
      let draws = 0, inst = 0;
      for (const t of OUT.tiles.values()) { const m = createInstancedMesh(t, unitBox, buildingMat, true, 140); dyn.meshes.push(m); scene.add(m); draws++; inst += t.n; }
      let trees = 0;
      for (const t of TREES.tiles.values()) { const m = createInstancedMesh(t, treeGeo, treeMat, false, 30); m.receiveShadow = false; dyn.meshes.push(m); scene.add(m); draws++; trees += t.n; }
      city.stats.quality = qName; city.stats.buildings = inst; city.stats.buildingTiles = OUT.tiles.size; city.stats.trees = trees;
      city.stats.treeTiles = TREES.tiles.size; city.stats.sheds = OUT.sheds; city.stats.towers = OUT.towers; city.stats.instancedDrawCalls = draws;
    }

    // ---------------------------------------------------------------
    // Landmarks
    // ---------------------------------------------------------------
    function fallbackLandmarks(Hh) {
      const out = [];
      for (const l of CFG.landmarks) {
        if (l.kind === 'terrain' || l.kind === 'town' || l.kind === 'cluster') continue;
        try {
          const gy = Hh.ground(l.x, l.z), g = new THREE.Group(); g.position.set(l.x, gy, l.z);
          const w = l.kind === 'tower' ? 45 : l.kind === 'dome' ? 160 : l.kind === 'block' ? 220 : l.kind === 'wheel' ? 100 : 90;
          const geo = l.kind === 'dome' ? Hh.geo.dome(w / 2, l.height, 24)
            : l.kind === 'wheel' ? Hh.geo.xf(Hh.geo.torus(l.height / 2 - 2, 1.5, 6, 40), { y: l.height / 2 })
              : Hh.geo.box(w, l.height, w * (l.kind === 'block' ? 0.5 : 1));
          g.add(Hh.mesh(geo, Hh.mat(l.kind === 'tower' ? '#6f8f8a' : '#c9c2b4', l.kind === 'tower' ? { glass: true, win: 2 } : { win: 1 })));
          Hh.obstacle.rect(l.x, l.z, w, w, 0, gy + l.height);
          out.push({ name: l.name, x: l.x, z: l.z, top: gy + l.height, group: g });
        } catch (e) { console.warn('[city] fallback landmark failed', l.name, e); }
      }
      return out;
    }
    function buildLandmarks() {
      let recs = [];
      try { recs = (typeof makeLandmarks === 'function' ? makeLandmarks(H) : fallbackLandmarks(H)) || []; }
      catch (e) { console.error('[city] landmarks failed, using fallback', e); recs = fallbackLandmarks(H); }
      lmRecords = [];
      for (const r of recs) {
        if (!r || !r.group) continue;
        // instanced parts (ferris-wheel gondolas) are culled by their base geometry's sphere -> never cull them
        r.group.traverse((o) => { if (o.isInstancedMesh) o.frustumCulled = false; });
        scene.add(r.group);
        obsCircleStatic(r.x, r.z, 40, r.top);
        lmRecords.push(r);
      }
      city.landmarks = lmRecords.map((r) => ({ name: r.name, x: r.x, z: r.z, top: r.top })).sort((a, b) => b.top - a.top);
      let meshes = 0; for (const r of lmRecords) r.group.traverse((o) => { if (o.isMesh) meshes++; });
      city.stats.landmarks = lmRecords.length; city.stats.landmarkMeshes = meshes;
    }

    // ---------------------------------------------------------------
    // Bridges
    // ---------------------------------------------------------------
    function nearestRiverPoint(x, z) {
      let best = null, bd = Infinity;
      for (const r of CFG.rivers) {
        const p = r.points;
        for (let i = 0; i + 1 < p.length; i++) {
          const ax = p[i].x, az = p[i].z, dx = p[i + 1].x - ax, dz = p[i + 1].z - az, l2 = dx * dx + dz * dz;
          let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0; t = clamp(t, 0, 1);
          const qx = ax + dx * t, qz = az + dz * t, dd = Math.hypot(x - qx, z - qz);
          if (dd < bd) { bd = dd; const len = Math.sqrt(l2); best = { x: qx, z: qz, dx: dx / len, dz: dz / len, w: p[i].w + (p[i + 1].w - p[i].w) * t, river: r.name }; }
        }
      }
      return best;
    }
    function buildBridges() {
      const grey = [], red = [];
      for (const bdef of BRIDGE_DEFS) {
        try {
          const p = G.toWorld(bdef[1], bdef[2]);
          const np = nearestRiverPoint(p.x, p.z);
          if (!np) continue;
          const deckW = bdef[3], nx = -np.dz, nz = np.dx;           // crossing direction (perpendicular to the river)
          const phi = Math.atan2(-nz, nx);                          // rotation about Y so local +x -> (nx, nz)
          const L = np.w + 140, cx = np.x, cz = np.z, deckY = 11;
          grey.push(H.geo.xf(H.geo.box(L, 2.2, deckW), { ry: phi, x: cx, y: deckY, z: cz }));
          // railings
          for (const side of [1, -1]) grey.push(H.geo.xf(H.geo.box(L, 1.2, 0.5), { ry: phi, x: cx + np.dx * side * (deckW / 2 - 0.4), y: deckY + 2.2, z: cz + np.dz * side * (deckW / 2 - 0.4) }));
          // piers
          for (let t = -np.w / 2 + 25; t < np.w / 2 - 10; t += 60) {
            for (const side of [1, -1]) {
              const px = cx + nx * t + np.dx * side * (deckW / 2 - 3), pz = cz + nz * t + np.dz * side * (deckW / 2 - 3);
              grey.push(H.geo.xf(H.geo.cyl(2, 2.5, deckY + 0.5, 8), { x: px, y: 0, z: pz }));
            }
          }
          // approach ramps descending to 2 m over 100 m
          const alpha = Math.atan2(deckY - 2, 100);
          for (const e of [1, -1]) {
            const g = H.geo.box(100, 2.2, deckW);
            H.geo.xf(g, { x: e * 50 });
            H.geo.xf(g, { rz: -e * alpha, ry: phi, x: cx + nx * e * L / 2, y: deckY, z: cz + nz * e * L / 2 });
            grey.push(g);
          }
          let top = deckY + 3.5;
          if (bdef[4] === 'arch') {
            const k = 5, span = np.w / k, Rr = span / 2;
            for (let i = 0; i < k; i++) {
              const t = -np.w / 2 + span * (i + 0.5);
              red.push(H.geo.xf(H.geo.torus(Rr, 1.6, 6, 28, Math.PI), { sy: 0.42, ry: phi, x: cx + nx * t, y: deckY + 2, z: cz + nz * t }));
            }
            top = deckY + 2 + Rr * 0.42 + 2;
          }
          obsRectStatic(cx, cz, L + 200, deckW + 4, phi, top);
        } catch (e) { console.warn('[city] bridge failed', bdef[0], e); }
      }
      if (grey.length) { const m = H.mesh(H.geo.merge(grey), H.mat('#8a8a88')); scene.add(m); city.stats.bridgeMeshes = 1; }
      if (red.length) { const m = H.mesh(H.geo.merge(red), H.mat('#c03428')); scene.add(m); city.stats.bridgeMeshes = 2; }
    }

    // ---------------------------------------------------------------
    // Ground painting (called once per ground canvas; ctx already in world metres, north up)
    // ---------------------------------------------------------------
    function paint(ctx, m) {
      const inner = !!m.isInner, rect = m.rect;
      const rnd = FS.mulberry32(hash3(3, 1, 4));
      ctx.save();
      ctx.beginPath(); ctx.rect(rect.x0, rect.z0, rect.x1 - rect.x0, rect.z1 - rect.z0); ctx.clip();
      // outer towns (grey cells)
      for (let t = 0; t < TOWN_TONES.length; t++) {
        ctx.fillStyle = TOWN_TONES[t];
        for (const c of townCells) if (c[3] === t) ctx.fillRect(c[0] - c[2] / 2, c[1] - c[2] / 2, c[2], c[2]);
      }
      // districts: streets + blocks
      for (const d of districts.concat([fallback])) {
        const list = d.blocks;
        if (!list || !list.length) continue;
        ctx.save(); ctx.translate(d.cx, d.cz); ctx.rotate(d.r);
        if (inner) {
          ctx.fillStyle = C_ASPHALT;
          for (const b of list) ctx.fillRect(b.u0 - b.wW / 2, b.v0 - b.wN / 2, (b.u1 - b.u0) + (b.wW + b.wE) / 2, (b.v1 - b.v0) + (b.wN + b.wS) / 2);
          ctx.fillStyle = C_ARTERIAL;
          for (const b of list) {
            const cw = (b.u1 - b.u0) + (b.wW + b.wE) / 2, ch = (b.v1 - b.v0) + (b.wN + b.wS) / 2;
            if (b.aN) ctx.fillRect(b.u0 - b.wW / 2, b.v0 - b.wN / 2, cw, b.wN / 2);
            if (b.aS) ctx.fillRect(b.u0 - b.wW / 2, b.v1, cw, b.wS / 2);
            if (b.aW) ctx.fillRect(b.u0 - b.wW / 2, b.v0 - b.wN / 2, b.wW / 2, ch);
            if (b.aE) ctx.fillRect(b.u1, b.v0 - b.wN / 2, b.wE / 2, ch);
          }
          ctx.fillStyle = C_CENTER;
          for (const b of list) {
            const cw = (b.u1 - b.u0) + (b.wW + b.wE) / 2, ch = (b.v1 - b.v0) + (b.wN + b.wS) / 2;
            if (b.aN) ctx.fillRect(b.u0 - b.wW / 2, b.v0 - b.wN / 2 - 1, cw, 2);
            if (b.aW) ctx.fillRect(b.u0 - b.wW / 2 - 1, b.v0 - b.wN / 2, 2, ch);
          }
          for (let t = 0; t < TONES.length; t++) {
            ctx.fillStyle = TONES[t];
            for (const b of list) if (b.tone === t) ctx.fillRect(b.u0, b.v0, b.u1 - b.u0, b.v1 - b.v0);
          }
          ctx.fillStyle = C_LANE;
          for (const b of list) if (b.lanes) {
            ctx.fillRect(b.u0 + 18, b.lanes.v0, (b.u1 - b.u0) - 36, 4);
            ctx.fillRect(b.u0 + 18, b.lanes.v1 - 4, (b.u1 - b.u0) - 36, 4);
          }
        } else {
          for (let t = 0; t < TONES_OUTER.length; t++) {
            ctx.fillStyle = TONES_OUTER[t];
            for (const b of list) if (b.tone === t) ctx.fillRect(b.u0 - b.wW / 2, b.v0 - b.wN / 2, (b.u1 - b.u0) + (b.wW + b.wE) / 2, (b.v1 - b.v0) + (b.wN + b.wS) / 2);
          }
        }
        ctx.restore();
      }
      // parks and campuses
      for (const p of CFG.parks) {
        ctx.save(); ctx.translate(p.x, p.z); if (p.rot) ctx.rotate(p.rot * D2R);
        ctx.fillStyle = p.campus ? C_CAMPUS : C_PARK;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        if (inner) {
          const n = Math.min(400, Math.round(p.w * p.h / 2500));
          for (let i = 0; i < n; i++) {
            ctx.fillStyle = MOTTLE[i & 3];
            const u = (rnd() - 0.5) * (p.w - 20), v = (rnd() - 0.5) * (p.h - 20), r = 6 + rnd() * 9;
            ctx.beginPath(); ctx.arc(u, v, r, 0, Math.PI * 2); ctx.fill();
          }
          ctx.strokeStyle = C_PATH; ctx.lineWidth = 3;
          ctx.strokeRect(-p.w / 2 + 16, -p.h / 2 + 16, p.w - 32, p.h - 32);
          ctx.beginPath();
          ctx.moveTo(-p.w / 2 + 16, -p.h / 2 + 16); ctx.lineTo(p.w / 2 - 16, p.h / 2 - 16);
          ctx.moveTo(-p.w / 2 + 16, p.h / 2 - 16); ctx.lineTo(p.w / 2 - 16, -p.h / 2 + 16);
          ctx.moveTo(-p.w / 2 + 16, 0); ctx.lineTo(p.w / 2 - 16, 0);
          ctx.stroke();
          if (p.campus) { ctx.strokeStyle = C_PLAZA; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(-p.w / 2, 0); ctx.lineTo(p.w / 2, 0); ctx.stroke(); }
        }
        ctx.restore();
      }
      ctx.fillStyle = C_CAMPUS_BLD;
      for (const r of campusRects) ctx.fillRect(r[0] - r[2] / 2, r[1] - r[3] / 2, r[2], r[3]);
      // plazas around landmarks
      ctx.fillStyle = C_PLAZA;
      for (const r of NOBUILD) if (r.plaza) ctx.fillRect(r.cx - r.hw, r.cz - r.hh, r.hw * 2, r.hh * 2);
      // elevated expressways
      ctx.strokeStyle = C_EXPRESS; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const e of EXPRESSWAYS) {
        ctx.lineWidth = e.w; ctx.beginPath();
        for (let i = 0; i < e.pts.length; i++) { if (i === 0) ctx.moveTo(e.pts[i].x, e.pts[i].z); else ctx.lineTo(e.pts[i].x, e.pts[i].z); }
        ctx.stroke();
      }
      ctx.restore();
    }
    function paintGround() {
      if (!W.paint) return;
      let canvases = 0;
      W.paint(function (ctx, m) { try { paint(ctx, m); canvases++; } catch (e) { console.warn('[city] ground paint failed', e); } });
      city.stats.paintedCanvases = canvases;
    }

    // ---------------------------------------------------------------
    // API
    // ---------------------------------------------------------------
    function init(sc) {
      scene = sc;
      const t0 = now();
      try {
        bindWorld();
        setupPalettes();
        setupNoBuild();
        CBDS = (CFG.cbds || []).slice();
        const rnd = FS.mulberry32(SEED);
        districts = DISTRICT_DEFS.map((d, i) => setupDistrict(d, i, rnd));
        fallback = setupDistrict(FALLBACK_DEF, -1, rnd);
        const t1 = now();
        buildGrid();
        const t2 = now();
        collectBlocks();
        const t3 = now();
        unitBox = new THREE.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0);
        treeGeo = new THREE.SphereGeometry(1, 6, 4); treeGeo.translate(0, 0.75, 0);
        H = makeHelpers({ ground: W.ground, obstacleRect: obsRectStatic, obstacleCircle: obsCircleStatic });
        buildingMat = H.mat('#ffffff', { win: 1 });
        treeMat = H.mat('#ffffff');
        initObstacleGrids();
        buildLandmarks();
        buildBridges();
        const t4 = now();
        quality = (FS.settings && QUALITY[FS.settings.quality]) ? FS.settings.quality : 'medium';
        buildDynamic(quality);
        const t5 = now();
        paintGround();
        const t6 = now();
        city.stats.blocks = blocks.length;
        city.stats.timing = { districts: Math.round(t1 - t0), grid: Math.round(t2 - t1), blocks: Math.round(t3 - t2), landmarksBridges: Math.round(t4 - t3), buildings: Math.round(t5 - t4), paint: Math.round(t6 - t5), total: Math.round(t6 - t0) };
        console.log('[city] ' + blocks.length + ' urban blocks, ' + city.stats.buildings + ' building instances in ' + city.stats.buildingTiles + ' tiles, ' +
          city.stats.trees + ' trees, ' + lmRecords.length + ' landmarks (' + city.stats.landmarkMeshes + ' meshes), quality ' + quality + ', ' + Math.round(t6 - t0) + ' ms' +
          (W.real ? '' : ' (no FS.world: flat fallback)'));
      } catch (e) {
        console.error('[city] init failed', e);
      }
    }

    function update(dt, cameraPos) {
      for (let i = 0; i < lmRecords.length; i++) {
        const r = lmRecords[i];
        if (!r.animate) continue;
        if (cameraPos && Math.hypot(cameraPos.x - r.x, cameraPos.z - r.z) > 8000) continue;
        try { r.animate(dt); } catch (e) { r.animate = null; console.warn('[city] animate failed', r.name, e); }
      }
    }

    function setQuality(q) {
      if (!QUALITY[q] || !scene || !blocks.length) return;
      if (q === quality) return;
      quality = q;
      try { buildDynamic(q); } catch (e) { console.error('[city] setQuality failed', e); }
    }
  })();
})();
