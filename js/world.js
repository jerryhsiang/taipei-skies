/* ============================================================
   Taipei Skies — js/world.js
   Terrain, water, ground textures, sky, sun, fog, clouds, shadows.

   Exports FS.world:
     init(scene, renderer), getHeight(x,z), isWater(x,z), getNormal(x,z),
     waterDistance(x,z), paintGround(fn), getGroundCanvases(),
     update(dt, camera, aircraftPos), setShadowFocus(aircraftPos, cameraPos),
     sunDir, sunLight, fog, skyColor, horizonColor, landLimits()

   Additions to the contract:
     waterDistance(x, z)  -> meters to the nearest sea/river water, capped at 2000
                             (0 on water). City uses it to keep riverside strips free.
     skyColor / horizonColor / fogColor are THREE.Color in DISPLAY (sRGB) space:
       r128 applies scene fog AFTER tone mapping + sRGB encoding, so fog.color must be
       an sRGB value to look like its hex. Use *.LinearVersions (skyColorLinear,
       horizonColorLinear) if you need them as material colors.
     stats   -> grid/texture sizes and init timings (ms).
     _gen    -> DOM-free heightmap / paint routines (used by offline tests).

   Heightmap: inner 1024x1024 Float32 grid over innerRect (27.4 m cells),
   outer 512x512 grid over the +-36 km world (141 m cells). Each grid stores
   h (elevation), w (signed distance to water, <0 inside) and c (signed
   distance to the coast, <0 in the sea).
   ============================================================ */
(function () {
  'use strict';
  const FS = window.FS;
  const C = FS.CONFIG;
  const G = FS.geo;
  const NZ = FS.noise;
  const clamp = G.clamp, lerp = G.lerp, smoothstep = G.smoothstep;
  const HALF = C.worldHalfSize;
  const IR = C.innerRect;
  const INNER_N = 1024, OUTER_N = 512;        // heightmap samples per side
  const INNER_TEX = 4096, OUTER_TEX = 2048;   // ground canvases
  const BASE_TEX = 1024;                      // natural base is painted at this size, then upscaled
  const INNER_SEG = 336, OUTER_SEG = 288;     // mesh segments: inner 83.3 m, outer 250 m (3:1 at the seam)
  const UC = C.urbanCenter;

  // ---------------------------------------------------------------
  // Grids
  // ---------------------------------------------------------------
  function makeGrid(n, x0, z0, x1, z1) {
    return {
      n, x0, z0, x1, z1, sx: (x1 - x0) / (n - 1), sz: (z1 - z0) / (n - 1),
      h: new Float32Array(n * n), w: new Float32Array(n * n), c: new Float32Array(n * n),
    };
  }
  const gridInner = makeGrid(INNER_N, IR.x0, IR.z0, IR.x1, IR.z1);
  const gridOuter = makeGrid(OUTER_N, -HALF, -HALF, HALF, HALF);

  function sampleGrid(g, arr, x, z) {
    const n = g.n, lim = n - 1.000001;
    let u = (x - g.x0) / g.sx, v = (z - g.z0) / g.sz;
    if (!(u > 0)) u = 0; else if (u > lim) u = lim;
    if (!(v > 0)) v = 0; else if (v > lim) v = lim;
    const i = u | 0, j = v | 0, fu = u - i, fv = v - j;
    const k = j * n + i;
    const a = arr[k], b = arr[k + 1], c = arr[k + n], d = arr[k + n + 1];
    return (a + (b - a) * fu) * (1 - fv) + (c + (d - c) * fu) * fv;
  }
  function inInner(x, z) { return x >= IR.x0 && x <= IR.x1 && z >= IR.z0 && z <= IR.z1; }
  function gridFor(x, z) { return inInner(x, z) ? gridInner : gridOuter; }
  function inWorld(x, z) { return x >= -HALF && x <= HALF && z >= -HALF && z <= HALF; }

  // ---------------------------------------------------------------
  // Rivers: packed segments [ax, az, bx, bz, halfA, halfB, cx, cz, boundR]
  // Upstream ends (first point of every river except the Tamsui, whose first
  // point is the confluence) are extended ~7 km into the hills, narrowing
  // to 25 m, so rivers do not stop dead at the edge of the authored data.
  // ---------------------------------------------------------------
  const RSEG = (function () {
    const segs = [];
    for (const river of C.rivers) {
      const pts = river.points.map((p) => ({ x: p.x, z: p.z, w: p.w }));
      if (river.name !== 'Tamsui River' && pts.length >= 2) {
        const p0 = pts[0], p1 = pts[1];
        let dx = p0.x - p1.x, dz = p0.z - p1.z;
        const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
        const ext = [];
        let px = p0.x, pz = p0.z, w = p0.w;
        for (let k = 0; k < 3; k++) {
          const ang = (k % 2 ? -1 : 1) * 0.28;
          const ex = dx * Math.cos(ang) - dz * Math.sin(ang), ez = dx * Math.sin(ang) + dz * Math.cos(ang);
          px += ex * 2400; pz += ez * 2400; w = Math.max(25, w * 0.55);
          ext.unshift({ x: px, z: pz, w });
        }
        pts.unshift(...ext);
      }
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const ha = a.w * 0.5, hb = b.w * 0.5;
        const cx = (a.x + b.x) * 0.5, cz = (a.z + b.z) * 0.5;
        const r = Math.hypot(b.x - a.x, b.z - a.z) * 0.5 + Math.max(ha, hb);
        segs.push(a.x, a.z, b.x, b.z, ha, hb, cx, cz, r);
      }
    }
    return new Float64Array(segs);
  })();

  // signed distance to the river water edge (negative inside the water)
  function riverEdgeDist(x, z) {
    let best = 1e9;
    for (let s = 0; s < RSEG.length; s += 9) {
      const ex = x - RSEG[s + 6], ez = z - RSEG[s + 7], lim = best + RSEG[s + 8];
      if (ex * ex + ez * ez > lim * lim) continue;
      const ax = RSEG[s], az = RSEG[s + 1], bx = RSEG[s + 2], bz = RSEG[s + 3];
      const vx = bx - ax, vz = bz - az;
      let t = ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + vx * t - x, pz = az + vz * t - z;
      const d = Math.sqrt(px * px + pz * pz) - (RSEG[s + 4] + (RSEG[s + 5] - RSEG[s + 4]) * t);
      if (d < best) best = d;
    }
    return best;
  }

  // ---------------------------------------------------------------
  // Coast: polyline NE -> SW; the sea is on the north/west side.
  // The sea polygon closes through far north corners.
  // ---------------------------------------------------------------
  const COAST = C.coast.map((p) => [p.x, p.z]);
  const SEAPOLY = COAST.concat([
    [-260000, COAST[COAST.length - 1][1]], [-260000, -260000], [260000, -260000], [260000, COAST[0][1]],
  ]);
  function inSea(x, z) {
    let inside = false;
    for (let i = 0, j = SEAPOLY.length - 1; i < SEAPOLY.length; j = i++) {
      const xi = SEAPOLY[i][0], zi = SEAPOLY[i][1], xj = SEAPOLY[j][0], zj = SEAPOLY[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }
  function coastDist(x, z) {
    let best = 1e18;
    for (let i = 0; i + 1 < COAST.length; i++) {
      const ax = COAST[i][0], az = COAST[i][1], vx = COAST[i + 1][0] - ax, vz = COAST[i + 1][1] - az;
      let t = ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + vx * t - x, pz = az + vz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) best = d2;
    }
    const d = Math.sqrt(best);
    return inSea(x, z) ? -d : d;
  }

  // ---------------------------------------------------------------
  // Airports: one oriented box per airport covering all runways (+400 m)
  // ---------------------------------------------------------------
  const APBOX = C.airports.map((a) => {
    const U = G.headingToDir(a.runways[0].heading);
    const ux = U.x, uz = U.z;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const r of a.runways) {
      const d = G.headingToDir(r.heading), nx = -d.z, nz = d.x;
      for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        const px = r.cx + d.x * (r.length / 2) * su + nx * (r.width / 2) * sv;
        const pz = r.cz + d.z * (r.length / 2) * su + nz * (r.width / 2) * sv;
        const u = (px - a.x) * ux + (pz - a.z) * uz, v = -(px - a.x) * uz + (pz - a.z) * ux;
        if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
      }
    }
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    return {
      icao: a.icao, elev: a.elev, ux, uz,
      cx: a.x + cu * ux - cv * uz, cz: a.z + cu * uz + cv * ux,
      hu: (maxU - minU) / 2 + 400, hv: (maxV - minV) / 2 + 400,
    };
  });
  let E_apElev = 0;
  function airportDist(x, z) {
    let best = 1e9;
    for (let i = 0; i < APBOX.length; i++) {
      const b = APBOX[i];
      const dx = x - b.cx, dz = z - b.cz;
      const du = Math.abs(dx * b.ux + dz * b.uz) - b.hu, dv = Math.abs(-dx * b.uz + dz * b.ux) - b.hv;
      const d = du > 0 && dv > 0 ? Math.sqrt(du * du + dv * dv) : Math.max(du, dv);
      if (d < best) { best = d; E_apElev = b.elev; }
    }
    return best;
  }

  // ---------------------------------------------------------------
  // Massifs
  // ---------------------------------------------------------------
  const RIDGE_AXIS = { Nangang: 80, Muzha: 75, Ankeng: 45, Tucheng: 50, Pingxi: 70, Keelung: 80 };
  const MASSIFS = C.mountains.map((m) => {
    const key = Object.keys(RIDGE_AXIS).find((k) => m.name.indexOf(k) === 0);
    const d = G.headingToDir(key ? RIDGE_AXIS[key] : 90);
    return { x: m.x, z: m.z, h: m.height, r: m.radius, ux: d.x, uz: d.z, ridge: m.kind === 'ridge', plateau: m.kind === 'plateau' };
  });
  let E_plateau = 0;
  // power soft-max (p = 8) of all massif bumps; rn = centred ridged noise (about -1.7..1.3),
  // warp = radial domain warp so footprints are not perfect circles/ellipses
  function massifHeight(x, z, rn, warp) {
    let acc = 0; E_plateau = 0;
    for (let i = 0; i < MASSIFS.length; i++) {
      const m = MASSIFS[i];
      const dx = x - m.x, dz = z - m.z;
      let d;
      if (m.ridge) { const u = dx * m.ux + dz * m.uz, v = -dx * m.uz + dz * m.ux; d = Math.sqrt(u * u + v * v * 4.94); }
      else d = Math.sqrt(dx * dx + dz * dz);
      d *= warp;
      if (d >= m.r) continue;
      const t = 1 - d / m.r;
      let bell;
      if (m.plateau) {
        bell = smoothstep(0, 0.25, t);
        if (bell > E_plateau) E_plateau = bell;
        bell *= 1 + 0.06 * rn;
      } else {
        bell = t * t * (3 - 2 * t);
        bell *= 1 + 0.42 * rn * (1 - bell * bell);
      }
      const hh = m.h * bell;
      if (hh <= 0) continue;
      const q = hh * hh, q4 = q * q;
      acc += q4 * q4;
    }
    return acc > 0 ? Math.pow(acc, 0.125) : 0;
  }

  // ---------------------------------------------------------------
  // The height model. Writes E_h (elevation), E_w (signed water dist), E_c (signed coast dist).
  // ---------------------------------------------------------------
  let E_h = 0, E_w = 0, E_c = 0;
  function evalPoint(x, z) {
    const wr = riverEdgeDist(x, z);
    const wc = coastDist(x, z);
    let w = wr < wc ? wr : wc;
    const dAp = airportDist(x, z);
    const apElev = E_apElev;
    // no water inside an airport footprint (the authored Keelung River clips the RCSS east end);
    // the river is lifted out over the outer 220 m of the footprint so there is no wall
    if (dAp < 0) { const lift = 45 * (1 - smoothstep(-220, 0, dAp)); if (w < lift) w = lift; }

    const dcx = x - UC.x, dcz = z - UC.z;
    const dC = Math.sqrt(dcx * dcx + dcz * dcz);

    // basin floor: 4 m at the centre, ~10 m at 13 km, slowly rising beyond; soft undulation
    let base = 4 + 6 * Math.pow(dC / 13000, 1.5) + 1.5 * NZ.fbm(x / 1500, z / 1500, 2);
    // Taoyuan coastal terrace (west, north of the Sanxia hills): flat, gently rising inland
    const west = smoothstep(-15000, -23000, x) * (1 - smoothstep(6000, 14000, z));
    if (west > 0) base = lerp(base, 20 + 0.004 * Math.max(wc, 0), west);

    // ridged noise for massif detail and the general folded-hill field
    const rn = (NZ.ridged(x / 2200, z / 2200, 5, 2.1, 0.5) - 0.6) / 0.3;
    const warp = 1 + 0.22 * NZ.fbm(x / 1400 + 3.1, z / 1400 + 7.7, 2);
    let hills = massifHeight(x, z, rn, warp);
    const plateau = E_plateau;
    const mask = smoothstep(11000, 19000, dC) * smoothstep(1500, 9000, wc) * (1 - 0.9 * west) * (1 - 0.85 * plateau);
    if (mask > 0.001) {
      const amp = 250 + 0.02 * Math.max(0, dC - 14000);
      const raw = NZ.ridged(x / 5500, z / 5500, 5, 2, 0.5);
      const f = clamp((raw - 0.3) / 0.7, 0, 1);
      hills += amp * mask * (Math.pow(f, 1.3) + 0.14);
    }
    // valleys along the rivers, no hills in the sea, taper at the world edge
    const valley = smoothstep(0, 1500, wr) * smoothstep(0, 800, wc);
    const edge = 1 - smoothstep(32000, 35800, Math.max(Math.abs(x), Math.abs(z)));
    let h = base + hills * valley * edge;

    // beach / mudflat strip, hills may rise again beyond ~500 m
    if (wc < 1500) { const cap = 1 + 0.035 * wc + 0.00015 * wc * wc; if (h > cap) h = cap; }
    // airports: flat at their elevation, blended out over 600 m
    if (dAp < 600) h = lerp(apElev, h, smoothstep(0, 600, dAp));
    // dry land in the basin never below 3 m
    if (h < 3 && w > 40 && wc > 100) h = 3;
    // river banks / shoreline: a few metres of slope down to the water
    if (w < 40) h *= smoothstep(0, 40, w);
    if (w <= 0) h = 0;
    E_h = h; E_w = w; E_c = wc;
  }

  function buildGrid(g) {
    const n = g.n;
    for (let j = 0; j < n; j++) {
      const z = g.z0 + j * g.sz;
      for (let i = 0; i < n; i++) {
        evalPoint(g.x0 + i * g.sx, z);
        const k = j * n + i;
        g.h[k] = E_h; g.w[k] = E_w; g.c[k] = E_c;
      }
    }
  }

  // ---------------------------------------------------------------
  // Public sampling
  // ---------------------------------------------------------------
  function getHeight(x, z) {
    if (!inWorld(x, z)) return 0;
    const g = gridFor(x, z);
    const h = sampleGrid(g, g.h, x, z);
    return h > 0 ? h : 0;
  }
  function waterSigned(x, z) {
    if (!inWorld(x, z)) return -1;
    const g = gridFor(x, z);
    return sampleGrid(g, g.w, x, z);
  }
  function isWater(x, z) { return waterSigned(x, z) < 0; }
  function waterDistance(x, z) { const w = waterSigned(x, z); return w < 0 ? 0 : w > 2000 ? 2000 : w; }
  // unit normal from central differences; e = sampling offset in metres
  function normalAt(x, z, e, out) {
    const hx = getHeight(x + e, z) - getHeight(x - e, z);
    const hz = getHeight(x, z + e) - getHeight(x, z - e);
    const nx = -hx / (2 * e), nz = -hz / (2 * e);
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    out[0] = nx * inv; out[1] = inv; out[2] = nz * inv;
    return out;
  }
  const _n3 = [0, 1, 0];
  function getNormal(x, z) {
    normalAt(x, z, inInner(x, z) ? gridInner.sx : gridOuter.sx, _n3);
    return new THREE.Vector3(_n3[0], _n3[1], _n3[2]);
  }

  // ---------------------------------------------------------------
  // Ground textures: natural base painted per pixel (DOM-free) at
  // BASE_TEX², upscaled onto the big canvases, then a few crisp vector
  // details (surf line, levees). City/airports paint on top later.
  // ---------------------------------------------------------------
  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  const PAL = {
    field1: hex('#95ad63'), field2: hex('#b9ad7b'), paddy: hex('#7e9d57'), terrace: hex('#a6a970'),
    forest: hex('#3f6b3a'), forestHi: hex('#2f5230'), rock: hex('#7b776a'), grassTop: hex('#8f9a5e'),
    river: hex('#5b7d86'), riverLight: hex('#7a9599'), seaNear: hex('#3a6f92'), seaDeep: hex('#1f4a6b'), foam: hex('#dfe8ea'),
    sand: hex('#c9bf9a'), mud: hex('#a3987a'), strip: hex('#7fae52'), stripDark: hex('#699547'), mangrove: hex('#5f7a45'),
  };
  const _col = [0, 0, 0];
  function mix3(a, b, t, out) { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; return out; }

  // px: Uint8ClampedArray (W*W*4); rect: world rect covered; g: grid to sample. Row 0 = north (rect.z0).
  function paintBase(px, W, rect, g) {
    const sx = (rect.x1 - rect.x0) / W, sz = (rect.z1 - rect.z0) / W;
    const e = Math.max(g.sx, 30), inv2e = 1 / (2 * e);
    const col = _col, tmp = [0, 0, 0], tmp2 = [0, 0, 0];
    let k = 0;
    for (let j = 0; j < W; j++) {
      const z = rect.z0 + (j + 0.5) * sz;
      for (let i = 0; i < W; i++, k += 4) {
        const x = rect.x0 + (i + 0.5) * sx;
        const h = sampleGrid(g, g.h, x, z), w = sampleGrid(g, g.w, x, z), c = sampleGrid(g, g.c, x, z);
        const n1 = NZ.fbm(x / 40, z / 40, 2);     // ~30 m grain (canopy mottling, field texture)
        if (w < 0) {
          if (c < 0) {
            // sea: darker away from the coast, thin foam at the shore
            mix3(PAL.seaNear, PAL.seaDeep, smoothstep(0, 3000, -c), col);
            const wv = n1 * 5;
            col[0] += wv; col[1] += wv; col[2] += wv;
            if (c > -14) mix3(col, PAL.foam, 0.55 * (1 + c / 14), col);
          } else {
            // river: muddy teal-grey with slow banding, lighter shallows at the banks
            const band = NZ.fbm(x / 160, z / 160, 1) * 9 + n1 * 3;
            col[0] = PAL.river[0] + band; col[1] = PAL.river[1] + band; col[2] = PAL.river[2] + band;
            if (w > -14) mix3(col, PAL.riverLight, 0.5 * (1 + w / 14), col);
          }
        } else {
          const dcx = x - UC.x, dcz = z - UC.z;
          const dC = Math.sqrt(dcx * dcx + dcz * dcz);
          // lowland: patchwork of fields, khaki and paddies
          const n2 = NZ.fbm(x / 240, z / 240, 2);
          mix3(PAL.field1, PAL.field2, smoothstep(-0.25, 0.25, n2), col);
          if (n2 > 0.26) mix3(col, PAL.paddy, smoothstep(0.26, 0.45, n2), col);
          if (x < -18000 && z < 12000) mix3(col, PAL.terrace, smoothstep(-18000, -24000, x) * 0.6, col);
          const grain = 1 + 0.06 * n1;
          col[0] *= grain; col[1] *= grain; col[2] *= grain;
          // hills: forest by elevation and slope, rock on steep faces, silver grass on the volcano tops
          let slope = 0;
          if (h > 12) {
            const hx = sampleGrid(g, g.h, x + e, z) - sampleGrid(g, g.h, x - e, z);
            const hz = sampleGrid(g, g.h, x, z + e) - sampleGrid(g, g.h, x, z - e);
            slope = Math.sqrt(hx * hx + hz * hz) * inv2e;
          }
          // forest: steep ground, ground well above the plain (but not the flat Taoyuan terrace), and hill
          // country as a whole (valleys included) — judged by the terrain height 500 m around the pixel
          const west = smoothstep(-15000, -23000, x) * (1 - smoothstep(6000, 14000, z));
          let f = smoothstep(25, 70, h) * (1 - west);
          const fs = smoothstep(0.1, 0.22, slope); if (fs > f) f = fs;
          const hc = 0.25 * (sampleGrid(g, g.h, x + 500, z) + sampleGrid(g, g.h, x - 500, z) + sampleGrid(g, g.h, x, z + 500) + sampleGrid(g, g.h, x, z - 500));
          const fh = smoothstep(45, 120, hc) * smoothstep(250, 800, c); if (fh > f) f = fh;
          if (f > 0.001) {
            mix3(PAL.forest, PAL.forestHi, smoothstep(300, 1000, h), tmp);
            const canopy = 1 + 0.16 * n1;
            tmp[0] *= canopy; tmp[1] *= canopy; tmp[2] *= canopy;
            const rk = smoothstep(0.9, 1.7, slope) * 0.55; if (rk > 0) mix3(tmp, PAL.rock, rk, tmp);
            const gt = smoothstep(880, 1080, h) * 0.55; if (gt > 0) mix3(tmp, PAL.grassTop, gt, tmp);
            mix3(col, tmp, f, col);
          }
          // riverside floodplain parks inside the levees (basin only); mangroves/mudflats toward the estuary
          if (w < 200 && dC < 14500 && h < 30) {
            if (c > 2500) {
              mix3(PAL.strip, PAL.stripDark, 0.5 + 0.5 * n1, tmp2);
              mix3(col, tmp2, 1 - smoothstep(170, 200, w), col);
            } else if (w < 140) {
              mix3(col, PAL.mangrove, (1 - smoothstep(100, 140, w)) * smoothstep(300, 2500, c), col);
            }
          }
          // wet bank right at the water, sand / mudflat strip along the coast
          if (w < 25) mix3(col, PAL.mud, (1 - w / 25) * 0.5, col);
          if (c < 110) { mix3(PAL.sand, PAL.mud, 0.5 + 0.5 * n1, tmp); mix3(col, tmp, 1 - smoothstep(35, 110, c), col); }
        }
        px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2]; px[k + 3] = 255;
      }
    }
  }

  const groundCanvases = []; // [{canvas, ctx, rect, pxPerM, isInner, texture}]
  function makeCanvas(size) { const cv = document.createElement('canvas'); cv.width = cv.height = size; return cv; }

  function withWorldTransform(gc, fn, mapper) {
    const ctx = gc.ctx, p = gc.pxPerM;
    ctx.save();
    ctx.setTransform(p, 0, 0, p, -gc.rect.x0 * p, -gc.rect.z0 * p);
    try { fn(ctx, mapper); } catch (err) { console.error('[world] ground paint callback failed', err); }
    ctx.restore();
  }

  function buildGroundCanvas(size, rect, g, isInner) {
    const base = makeCanvas(BASE_TEX);
    const bctx = base.getContext('2d');
    const img = bctx.createImageData(BASE_TEX, BASE_TEX);
    paintBase(img.data, BASE_TEX, rect, g);
    bctx.putImageData(img, 0, 0);
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    try { ctx.imageSmoothingQuality = 'high'; } catch (e) { /* optional */ }
    ctx.drawImage(base, 0, 0, size, size);
    const gc = { canvas, ctx, rect, pxPerM: size / (rect.x1 - rect.x0), isInner, texture: null };
    if (isInner) { try { overlayGrain(gc); } catch (err) { console.warn('[world] grain overlay skipped', err); } }
    paintNaturalLines(gc);
    return gc;
  }

  // fine grain at full canvas resolution (tiled 256² noise pattern, one fill) so the upscaled base
  // does not look blurry from low altitude; lighter over land, skipped over water via low alpha
  function overlayGrain(gc) {
    const S = 256, tile = makeCanvas(S), tctx = tile.getContext('2d'), img = tctx.createImageData(S, S), d = img.data;
    const rand = FS.mulberry32(4242), nz = FS.makeNoise(99);
    for (let j = 0, p = 0; j < S; j++) {
      for (let i = 0; i < S; i++, p += 4) {
        const n = nz.fbm(i / 9, j / 9, 2) * 0.6 + (rand() - 0.5) * 0.5;
        const v = n > 0 ? 255 : 0;
        d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = Math.round(Math.min(1, Math.abs(n)) * 46);
      }
    }
    tctx.putImageData(img, 0, 0);
    const ctx = gc.ctx, pat = ctx.createPattern(tile, 'repeat');
    if (!pat) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, gc.canvas.width, gc.canvas.height);
    ctx.restore();
  }

  // crisp vector details: surf line along the coast, levee crests along the basin rivers
  function paintNaturalLines(gc) {
    withWorldTransform(gc, (ctx) => {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      C.coast.forEach((p, i) => { if (i) ctx.lineTo(p.x, p.z); else ctx.moveTo(p.x, p.z); });
      ctx.strokeStyle = 'rgba(190,212,216,0.22)'; ctx.lineWidth = 90; ctx.stroke();
      ctx.strokeStyle = 'rgba(234,241,243,0.8)'; ctx.lineWidth = gc.isInner ? 14 : 40; ctx.stroke();
      ctx.beginPath();
      for (const river of C.rivers) {
        const pts = river.points;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], b = pts[i + 1];
          const dA = Math.hypot(a.x - UC.x, a.z - UC.z), dB = Math.hypot(b.x - UC.x, b.z - UC.z);
          if (dA > 14500 || dB > 14500 || coastDist(a.x, a.z) < 2500 || coastDist(b.x, b.z) < 2500) continue;
          const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
          for (let side = -1; side <= 1; side += 2) {
            const oa = a.w * 0.5 + 182, ob = b.w * 0.5 + 182;
            ctx.moveTo(a.x + nx * oa * side, a.z + nz * oa * side);
            ctx.lineTo(b.x + nx * ob * side, b.z + nz * ob * side);
          }
        }
      }
      ctx.strokeStyle = '#55693f'; ctx.lineWidth = gc.isInner ? 12 : 36; ctx.stroke();
    });
  }

  // roughness (linear): water glossy, land matte, damp sand in between. Same layout as the height grid.
  function buildRoughnessCanvas(g) {
    const n = g.n, canvas = makeCanvas(n), ctx = canvas.getContext('2d');
    const img = ctx.createImageData(n, n), d = img.data;
    for (let k = 0, p = 0; k < n * n; k++, p += 4) {
      const w = g.w[k], c = g.c[k];
      let r;
      if (w < 0) r = 0.12;
      else {
        r = lerp(0.45, 0.95, smoothstep(0, 60, w));
        if (c < 80) { const rc = lerp(0.5, 0.95, smoothstep(0, 80, c)); if (rc < r) r = rc; }
      }
      const v = Math.round(r * 255);
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function paintGround(fn) {
    if (typeof fn !== 'function') return;
    for (const gc of groundCanvases) {
      const mapper = { rect: gc.rect, pxPerM: gc.pxPerM, canvas: gc.canvas, isInner: gc.isInner };
      withWorldTransform(gc, fn, mapper);
      if (gc.texture) gc.texture.needsUpdate = true;
    }
  }
  function getGroundCanvases() {
    return groundCanvases.map((gc) => ({ canvas: gc.canvas, rect: gc.rect, pxPerM: gc.pxPerM, isInner: gc.isInner }));
  }

  // ---------------------------------------------------------------
  // Terrain meshes: inner (INNER_SEG²) over innerRect, outer (OUTER_SEG²)
  // over the world with a hole for the inner rect, plus a far sea plane.
  // The seam is watertight: outer vertices on the inner rect edge take the
  // inner grid's height, and the two intermediate inner vertices per outer
  // cell are linearly interpolated between them.
  // ---------------------------------------------------------------
  let meshInner = null, meshOuter = null, farPlane = null;
  const _nrm = [0, 1, 0];

  function buildTerrainGeometry(rect, segs, heightFn, epsFn, skipCell) {
    const nv = segs + 1;
    const pos = new Float32Array(nv * nv * 3), nor = new Float32Array(nv * nv * 3), uv = new Float32Array(nv * nv * 2);
    const dx = (rect.x1 - rect.x0) / segs, dz = (rect.z1 - rect.z0) / segs;
    for (let j = 0; j < nv; j++) {
      const z = rect.z0 + j * dz;
      for (let i = 0; i < nv; i++) {
        const x = rect.x0 + i * dx, k = j * nv + i;
        pos[k * 3] = x; pos[k * 3 + 1] = heightFn(x, z); pos[k * 3 + 2] = z;
        normalAt(x, z, epsFn(x, z), _nrm);
        nor[k * 3] = _nrm[0]; nor[k * 3 + 1] = _nrm[1]; nor[k * 3 + 2] = _nrm[2];
        uv[k * 2] = i / segs; uv[k * 2 + 1] = 1 - j / segs;
      }
    }
    let count = 0;
    for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) if (!skipCell || !skipCell(i, j)) count++;
    const idx = new Uint32Array(count * 6);
    let p = 0;
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        if (skipCell && skipCell(i, j)) continue;
        const a = j * nv + i, b = (j + 1) * nv + i, c = (j + 1) * nv + i + 1, d = j * nv + i + 1;
        idx[p++] = a; idx[p++] = b; idx[p++] = d; idx[p++] = b; idx[p++] = c; idx[p++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  // inner boundary vertices between the (every 3rd) shared vertices follow the outer edge linearly
  function fixInnerSeam(geo, nv) {
    const pos = geo.attributes.position.array;
    const fix = (at) => {
      for (let t = 0; t < nv; t++) {
        const r = t % 3; if (!r) continue;
        const t0 = t - r, t1 = t0 + 3; if (t1 >= nv) continue;
        const h0 = pos[at(t0) * 3 + 1], h1 = pos[at(t1) * 3 + 1];
        pos[at(t) * 3 + 1] = h0 + ((h1 - h0) * r) / 3;
      }
    };
    fix((t) => t); fix((t) => (nv - 1) * nv + t); fix((t) => t * nv); fix((t) => t * nv + nv - 1);
  }

  function onInnerEdge(x, z) {
    const ex = Math.abs(x - IR.x0) < 0.5 || Math.abs(x - IR.x1) < 0.5, ez = Math.abs(z - IR.z0) < 0.5 || Math.abs(z - IR.z1) < 0.5;
    return (ex && z >= IR.z0 - 0.5 && z <= IR.z1 + 0.5) || (ez && x >= IR.x0 - 0.5 && x <= IR.x1 + 0.5);
  }

  function buildTerrain(scene) {
    const gcI = groundCanvases[0], gcO = groundCanvases[1];
    const worldRect = { x0: -HALF, z0: -HALF, x1: HALF, z1: HALF };

    const geoInner = buildTerrainGeometry(IR, INNER_SEG, (x, z) => sampleGrid(gridInner, gridInner.h, x, z), () => gridInner.sx);
    fixInnerSeam(geoInner, INNER_SEG + 1);
    geoInner.attributes.position.needsUpdate = true;

    const cell = (2 * HALF) / OUTER_SEG;
    const i0 = Math.round((IR.x0 + HALF) / cell), i1 = Math.round((IR.x1 + HALF) / cell);
    const j0 = Math.round((IR.z0 + HALF) / cell), j1 = Math.round((IR.z1 + HALF) / cell);
    const geoOuter = buildTerrainGeometry(worldRect, OUTER_SEG,
      (x, z) => (onInnerEdge(x, z) ? sampleGrid(gridInner, gridInner.h, x, z) : sampleGrid(gridOuter, gridOuter.h, x, z)),
      (x, z) => (onInnerEdge(x, z) ? gridInner.sx : gridOuter.sx),
      (i, j) => i >= i0 && i < i1 && j >= j0 && j < j1);

    // ground canvases may be missing if painting failed: fall back to a plain green so the terrain still exists
    const texI = gcI ? FS.textureFromCanvas(gcI.canvas, { anisotropy: 8 }) : null; if (gcI) gcI.texture = texI;
    const texO = gcO ? FS.textureFromCanvas(gcO.canvas, { anisotropy: 4 }) : null; if (gcO) gcO.texture = texO;
    const roughI = FS.textureFromCanvas(buildRoughnessCanvas(gridInner), { linear: true, anisotropy: 2 });
    const roughO = FS.textureFromCanvas(buildRoughnessCanvas(gridOuter), { linear: true, anisotropy: 2 });
    const matI = new THREE.MeshStandardMaterial({ map: texI, roughnessMap: roughI, roughness: 1, metalness: 0, color: FS.color(texI ? '#ffffff' : '#8fa860') });
    const matO = new THREE.MeshStandardMaterial({ map: texO, roughnessMap: roughO, roughness: 1, metalness: 0, color: FS.color(texO ? '#ffffff' : '#6f8f4e') });

    meshInner = new THREE.Mesh(geoInner, matI);
    meshOuter = new THREE.Mesh(geoOuter, matO);
    for (const m of [meshInner, meshOuter]) {
      m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false; m.updateMatrix();
      scene.add(m);
    }
    meshInner.name = 'terrain-inner'; meshOuter.name = 'terrain-outer';

    // far sea plane so the world never shows an edge (fogged to the horizon colour)
    farPlane = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), new THREE.MeshBasicMaterial({ color: FS.color('#2d5f83') }));
    farPlane.rotation.x = -Math.PI / 2;
    farPlane.position.y = -0.5;
    farPlane.frustumCulled = false;
    farPlane.renderOrder = -5;
    farPlane.name = 'far-plane';
    farPlane.updateMatrix(); farPlane.matrixAutoUpdate = false;
    scene.add(farPlane);
    return { triangles: (geoInner.index.count + geoOuter.index.count) / 3 };
  }

  // ---------------------------------------------------------------
  // Sky dome, sun, lights, fog, shadows
  // Sky/fog colours are display-space (sRGB): r128 mixes fog after tone
  // mapping + encoding, and the dome/cloud shaders write gl_FragColor raw,
  // so authoring them in sRGB keeps sky, haze and fogged terrain seamless.
  // ---------------------------------------------------------------
  const sunDir = (function () {
    const s = C.sun, d = G.headingToDir(s.azimuthDeg), el = s.elevationDeg * G.D2R;
    return new THREE.Vector3(d.x * Math.cos(el), Math.sin(el), d.z * Math.cos(el)).normalize();
  })();
  const SKY = { zenith: '#3b6fb7', mid: '#8db1dc', horizon: '#c9d4de', warm: '#e8dbc4', sun: '#fff5df' };
  const skyColor = new THREE.Color(SKY.zenith);
  const horizonColor = new THREE.Color(SKY.horizon);
  const fogColor = new THREE.Color(SKY.horizon);
  let sunLight = null, hemiLight = null, ambLight = null, fog = null;
  let skyDome = null, sunDisc = null, sunGlow = null;

  const SKY_VERT = [
    'varying vec3 vDir;',
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'void main() {',
    '  vDir = normalize(position);',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '}',
  ].join('\n');
  const SKY_FRAG = [
    'uniform vec3 zenith; uniform vec3 mid; uniform vec3 horizon; uniform vec3 warm; uniform vec3 sunCol; uniform vec3 sunDirection;',
    'varying vec3 vDir;',
    '#include <common>',
    '#include <logdepthbuf_pars_fragment>',
    'void main() {',
    '  #include <logdepthbuf_fragment>',
    '  vec3 d = normalize(vDir);',
    '  float t = clamp(d.y, 0.0, 1.0);',
    '  vec3 col = mix(horizon, mid, smoothstep(0.0, 0.2, t));',
    '  col = mix(col, zenith, smoothstep(0.12, 0.85, t));',
    '  vec2 dh = normalize(d.xz + vec2(1e-5, 0.0)); vec2 sh = normalize(sunDirection.xz);',
    '  float az = max(dot(dh, sh), 0.0);',
    '  col = mix(col, warm, az * az * (1.0 - smoothstep(0.0, 0.35, t)) * 0.55);',
    '  if (d.y < 0.0) col = mix(horizon, horizon * 0.88, clamp(-d.y * 6.0, 0.0, 1.0));',
    '  float cosA = max(dot(d, sunDirection), 0.0);',
    '  float glow = pow(cosA, 10.0) * 0.22 + pow(cosA, 90.0) * 0.4 + pow(cosA, 700.0) * 0.6;',
    '  col += sunCol * glow;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  function radialCanvas(size, stops) {
    const cv = makeCanvas(size), ctx = cv.getContext('2d');
    const gr = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const s of stops) gr.addColorStop(s[0], s[1]);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, size, size);
    return cv;
  }

  function buildSky(scene) {
    const geo = new THREE.SphereGeometry(90000, 40, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        zenith: { value: new THREE.Color(SKY.zenith) }, mid: { value: new THREE.Color(SKY.mid) },
        horizon: { value: new THREE.Color(SKY.horizon) }, warm: { value: new THREE.Color(SKY.warm) },
        sunCol: { value: new THREE.Color(SKY.sun) }, sunDirection: { value: sunDir.clone() },
      },
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, transparent: false,
    });
    skyDome = new THREE.Mesh(geo, mat);
    skyDome.renderOrder = -10;
    skyDome.frustumCulled = false;
    skyDome.name = 'sky-dome';
    scene.add(skyDome);

    // sun disc + soft glow: opaque-list additive sprites drawn right after the dome, so terrain occludes them
    const discTex = FS.textureFromCanvas(radialCanvas(128, [[0, 'rgba(255,250,235,1)'], [0.55, 'rgba(255,246,220,1)'], [0.72, 'rgba(255,240,200,0.6)'], [1, 'rgba(255,235,190,0)']]));
    const glowTex = FS.textureFromCanvas(radialCanvas(256, [[0, 'rgba(255,240,205,0.55)'], [0.25, 'rgba(255,225,170,0.22)'], [0.6, 'rgba(255,215,160,0.06)'], [1, 'rgba(255,210,150,0)']]));
    const spriteMat = (map, hexCol) => new THREE.SpriteMaterial({
      map, color: FS.color(hexCol), blending: THREE.AdditiveBlending, transparent: false, depthWrite: false, depthTest: false, fog: false,
    });
    sunDisc = new THREE.Sprite(spriteMat(discTex, '#fff6e0'));
    sunDisc.scale.set(1500, 1500, 1);
    sunDisc.renderOrder = -9;
    sunGlow = new THREE.Sprite(spriteMat(glowTex, '#ffe9c4'));
    sunGlow.scale.set(16000, 16000, 1);
    sunGlow.renderOrder = -9;
    sunDisc.frustumCulled = false; sunGlow.frustumCulled = false;
    scene.add(sunGlow); scene.add(sunDisc);
  }

  function buildLights(scene) {
    sunLight = new THREE.DirectionalLight(FS.color('#fff0d8'), 1.7);
    sunLight.position.copy(sunDir).multiplyScalar(2000);
    sunLight.target.position.set(0, 0, 0);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 1.0;
    const sc = sunLight.shadow.camera;
    sc.left = -1000; sc.right = 1000; sc.top = 1000; sc.bottom = -1000; sc.near = 10; sc.far = 7000;
    sc.updateProjectionMatrix();
    scene.add(sunLight); scene.add(sunLight.target);
    hemiLight = new THREE.HemisphereLight(FS.color('#9dc0e8'), FS.color('#6d6a5a'), 0.55);
    scene.add(hemiLight);
    ambLight = new THREE.AmbientLight(FS.color('#ffffff'), 0.12);
    scene.add(ambLight);
    fog = new THREE.FogExp2(fogColor.getHex(), 0.000045);
    scene.fog = fog;
  }

  let shadowSize = 0, shadowFar = 0;
  function setShadowFocus(aircraftPos, cameraPos) {
    if (!sunLight || !aircraftPos) return;
    const ax = aircraftPos.x, ay = aircraftPos.y, az = aircraftPos.z;
    const agl = Math.max(0, ay - getHeight(ax, az));
    const size = clamp(agl * 1.5, 350, 2500);
    const far = 2000 + agl * 1.8 + size * 1.6 + 800;
    sunLight.target.position.set(ax, ay, az);
    sunLight.position.set(ax + sunDir.x * 2000, ay + sunDir.y * 2000, az + sunDir.z * 2000);
    if (Math.abs(size - shadowSize) > shadowSize * 0.02 || Math.abs(far - shadowFar) > shadowFar * 0.05) {
      const sc = sunLight.shadow.camera;
      sc.left = -size; sc.right = size; sc.top = size; sc.bottom = -size; sc.near = 10; sc.far = far;
      sc.updateProjectionMatrix();
      sunLight.shadow.normalBias = 0.3 + size / 1500;
      shadowSize = size; shadowFar = far;
    }
  }

  // ---------------------------------------------------------------
  // Clouds: ~35 cumulus clusters of soft billboard puffs in ONE instanced
  // draw call (sorted back-to-front every 0.4 s, drifting with the wind),
  // plus a faint cirrus veil at 8 km.
  // ---------------------------------------------------------------
  let cloudMesh = null, cloudGeo = null, cirrus = null;
  const puffs = []; // {x, y, z, size, shade, rot, alpha, d}
  const windVel = { x: 0, z: 0 };
  let sortTimer = 0;

  const CLOUD_VERT = [
    'attribute vec3 iOffset; attribute vec4 iParam;',
    'varying vec2 vUv; varying float vShade; varying float vAlpha; varying float vFogDepth;',
    '#include <common>',
    '#include <logdepthbuf_pars_vertex>',
    'void main() {',
    '  vUv = uv; vShade = iParam.y; vAlpha = iParam.w;',
    '  float c = cos(iParam.z), s = sin(iParam.z);',
    '  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iParam.x;',
    '  vec4 mvPosition = modelViewMatrix * vec4(iOffset, 1.0);',
    '  mvPosition.xy += p;',
    '  vFogDepth = -mvPosition.z;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <logdepthbuf_vertex>',
    '}',
  ].join('\n');
  const CLOUD_FRAG = [
    'uniform sampler2D map; uniform vec3 fogColor; uniform float fogDensity; uniform vec3 colTop; uniform vec3 colBottom;',
    'varying vec2 vUv; varying float vShade; varying float vAlpha; varying float vFogDepth;',
    '#include <common>',
    '#include <logdepthbuf_pars_fragment>',
    'void main() {',
    '  #include <logdepthbuf_fragment>',
    '  float a = texture2D(map, vUv).a * vAlpha;',
    '  if (a < 0.01) discard;',
    '  vec3 col = mix(colBottom, colTop, vUv.y) * vShade;',
    '  float f = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);',
    '  col = mix(col, fogColor, f);',
    '  gl_FragColor = vec4(col, a);',
    '}',
  ].join('\n');

  // soft puff with a noisy edge (alpha only)
  function puffCanvas() {
    const S = 256, cv = makeCanvas(S), ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
    const nz = FS.makeNoise(7);
    for (let j = 0, p = 0; j < S; j++) {
      for (let i = 0; i < S; i++, p += 4) {
        const u = ((i + 0.5) / S) * 2 - 1, v = ((j + 0.5) / S) * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const rr = r * (1 + 0.3 * nz.fbm(u * 2.6 + 5, v * 2.6 + 5, 3));
        let a = 1 - smoothstep(0.3, 1.0, rr);
        a *= 0.82 + 0.18 * (0.5 + 0.5 * nz.fbm(u * 5 + 20, v * 5 + 20, 2));
        d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // streaky high cloud (alpha only)
  function cirrusCanvas() {
    const S = 512, cv = makeCanvas(S), ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
    const nz = FS.makeNoise(11);
    for (let j = 0, p = 0; j < S; j++) {
      for (let i = 0; i < S; i++, p += 4) {
        const u = i / S, v = j / S;
        const n = nz.fbm(u * 3 + 0.5 * nz.fbm(u * 2, v * 9, 2), v * 16, 3);
        const a = smoothstep(0.05, 0.55, n) * (0.55 + 0.45 * nz.fbm(u * 1.5, v * 1.5, 2));
        d[p] = 255; d[p + 1] = 255; d[p + 2] = 255; d[p + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  function writePuffs(sort, camPos) {
    if (sort && camPos) {
      for (const p of puffs) { const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z; p.d = dx * dx + dy * dy + dz * dz; }
      puffs.sort((a, b) => b.d - a.d);
    }
    const off = cloudGeo.attributes.iOffset, par = cloudGeo.attributes.iParam;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i];
      off.array[i * 3] = p.x; off.array[i * 3 + 1] = p.y; off.array[i * 3 + 2] = p.z;
      if (sort) { par.array[i * 4] = p.size; par.array[i * 4 + 1] = p.shade; par.array[i * 4 + 2] = p.rot; par.array[i * 4 + 3] = p.alpha; }
    }
    off.needsUpdate = true;
    if (sort) par.needsUpdate = true;
  }

  function buildClouds(scene) {
    const rand = FS.mulberry32(20260927);
    const wind = C.wind || { fromDeg: 280, speed: 2.5 };
    const wd = G.headingToDir(wind.fromDeg + 180);
    windVel.x = wd.x * wind.speed; windVel.z = wd.z * wind.speed;

    const clusters = [];
    let basinCount = 0, tries = 0;
    while (clusters.length < 35 && tries++ < 6000) {
      const x = (rand() * 2 - 1) * (HALF - 3000), z = (rand() * 2 - 1) * (HALF - 3000);
      const inBasin = Math.hypot(x - UC.x, z - UC.z) < UC.radius;
      if (inBasin && basinCount >= 5) continue;
      const hgt = getHeight(x, z);
      if (rand() > 0.22 + Math.min(1, hgt / 500) * 0.78) continue; // mountains attract clouds
      if (clusters.some((c) => Math.hypot(c.x - x, c.z - z) < 2600)) continue;
      if (inBasin) basinCount++;
      clusters.push({ x, z, y: 1200 + rand() * 1000 + Math.min(hgt, 800) * 0.35 });
    }
    puffs.length = 0;
    for (const cl of clusters) {
      const n = 5 + Math.floor(rand() * 5), spread = 320 + rand() * 380;
      for (let k = 0; k < n; k++) {
        const ang = rand() * Math.PI * 2, rr = (k === 0 ? 0 : Math.sqrt(rand())) * spread;
        puffs.push({
          x: cl.x + Math.cos(ang) * rr, y: cl.y + (rand() - 0.5) * 150 + (k === 0 ? 70 : 0), z: cl.z + Math.sin(ang) * rr,
          size: 260 + rand() * 380 + (k === 0 ? 120 : 0), shade: 0.86 + rand() * 0.14, rot: (rand() - 0.5) * 0.6, alpha: 0.72 + rand() * 0.28, d: 0,
        });
      }
    }

    const base = new THREE.PlaneGeometry(1, 1);
    cloudGeo = new THREE.InstancedBufferGeometry();
    cloudGeo.setIndex(base.index);
    cloudGeo.setAttribute('position', base.attributes.position);
    cloudGeo.setAttribute('uv', base.attributes.uv);
    const n = puffs.length;
    const offAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    offAttr.setUsage(THREE.DynamicDrawUsage);
    cloudGeo.setAttribute('iOffset', offAttr);
    cloudGeo.setAttribute('iParam', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    cloudGeo.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: FS.textureFromCanvas(puffCanvas(), { linear: true, anisotropy: 1 }) },
        fogColor: { value: new THREE.Color(SKY.horizon) }, fogDensity: { value: 0.000045 },
        colTop: { value: new THREE.Color('#f7f8f9') }, colBottom: { value: new THREE.Color('#b4bcc7') },
      },
      vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG,
      transparent: true, depthWrite: false, depthTest: true, fog: true, side: THREE.DoubleSide,
    });
    cloudMesh = new THREE.Mesh(cloudGeo, mat);
    cloudMesh.frustumCulled = false;
    cloudMesh.renderOrder = 5;
    cloudMesh.name = 'clouds';
    scene.add(cloudMesh);
    writePuffs(true, { x: 0, y: 1500, z: 0 });

    const cirMat = new THREE.MeshBasicMaterial({
      map: FS.textureFromCanvas(cirrusCanvas(), { anisotropy: 4 }), color: FS.color('#ffffff'),
      transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
    });
    cirrus = new THREE.Mesh(new THREE.PlaneGeometry(220000, 220000), cirMat);
    cirrus.rotation.x = -Math.PI / 2;
    cirrus.position.y = 8000;
    cirrus.renderOrder = 4;
    cirrus.frustumCulled = false;
    cirrus.name = 'cirrus';
    scene.add(cirrus);
    return puffs.length;
  }

  function update(dt, camera, aircraftPos) {
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    if (camera && camera.position) {
      if (skyDome) skyDome.position.copy(camera.position);
      if (sunDisc) sunDisc.position.copy(camera.position).addScaledVector(sunDir, 80000);
      if (sunGlow) sunGlow.position.copy(camera.position).addScaledVector(sunDir, 79000);
    }
    if (cloudMesh && puffs.length) {
      const mx = windVel.x * dt, mz = windVel.z * dt;
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i];
        p.x += mx; p.z += mz;
        if (p.x > HALF) p.x -= 2 * HALF; else if (p.x < -HALF) p.x += 2 * HALF;
        if (p.z > HALF) p.z -= 2 * HALF; else if (p.z < -HALF) p.z += 2 * HALF;
      }
      sortTimer -= dt;
      const doSort = sortTimer <= 0 && camera && camera.position;
      if (doSort) sortTimer = 0.4;
      writePuffs(!!doSort, doSort ? camera.position : null);
    }
  }

  // ---------------------------------------------------------------
  // Init / public object
  // ---------------------------------------------------------------
  const stats = {
    innerGrid: INNER_N, outerGrid: OUTER_N, innerCell: gridInner.sx, outerCell: gridOuter.sx,
    innerTex: INNER_TEX, outerTex: OUTER_TEX, innerSeg: INNER_SEG, outerSeg: OUTER_SEG, triangles: 0, puffs: 0, timings: {},
  };
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  function timed(label, fn) {
    const t0 = now();
    try { fn(); } catch (err) { console.error('[world] ' + label + ' failed:', err); }
    stats.timings[label] = Math.round(now() - t0);
  }

  let inited = false;
  function init(scene, renderer) {
    if (inited) return;
    inited = true;
    if (renderer && !FS.renderer) FS.renderer = renderer;
    const t0 = now();
    timed('heightmap', () => { buildGrid(gridInner); buildGrid(gridOuter); });
    timed('groundTextures', () => {
      groundCanvases.length = 0;
      groundCanvases.push(buildGroundCanvas(INNER_TEX, IR, gridInner, true));
      groundCanvases.push(buildGroundCanvas(OUTER_TEX, { x0: -HALF, z0: -HALF, x1: HALF, z1: HALF }, gridOuter, false));
    });
    timed('terrainMeshes', () => { stats.triangles = buildTerrain(scene).triangles; });
    timed('sky', () => buildSky(scene));
    timed('lights', () => buildLights(scene));
    timed('clouds', () => { stats.puffs = buildClouds(scene); });
    stats.timings.total = Math.round(now() - t0);
    world.sunLight = sunLight; world.hemiLight = hemiLight; world.fog = fog;
    world.meshes = { inner: meshInner, outer: meshOuter, farPlane, skyDome, clouds: cloudMesh, cirrus };
    console.log('[world] ready in ' + stats.timings.total + ' ms', stats.timings);
  }

  function landLimits() { return { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF }; }

  const world = (FS.world = {
    init, getHeight, isWater, getNormal, waterDistance, paintGround, getGroundCanvases, update, setShadowFocus, landLimits,
    sunDir, sunLight: null, hemiLight: null, fog: null,
    skyColor, horizonColor, fogColor,
    skyColorLinear: skyColor.clone().convertSRGBToLinear(),
    horizonColorLinear: horizonColor.clone().convertSRGBToLinear(),
    innerRect: IR, stats, meshes: null,
    _gen: { gridInner, gridOuter, buildGrid, evalPoint, paintBase, sampleGrid, coastDist, riverEdgeDist, airportDist, normalAt, puffs, APBOX, MASSIFS },
  });
})();
