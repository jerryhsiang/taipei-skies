# Taipei Skies — module contract

A browser flight simulator over Taipei, built with **Three.js r128 (global `THREE`, UMD build from cdnjs)**.
Six plain-script modules share the global namespace `window.FS`. Read `js/config.js` (constants, geo helpers,
noise, input, events, settings) and `js/main.js` (init order, game loop, cameras, scenarios) before writing yours.

## Hard constraints (the page runs inside a locked-down sandbox)
- **No network access of any kind**: no fetch/XHR, no image URLs, no textures from the web, no fonts you load yourself.
  Everything (terrain, textures, buildings, aircraft, sounds) is generated in code (canvas 2D, math, WebAudio).
- **Plain `<script>` files.** No `import`/`export`, no bundler, no TypeScript. ES2020 syntax is fine (optional chaining, etc.).
  Wrap your file in an IIFE and attach exactly one object to `window.FS` (e.g. `FS.world = {...}`).
- Only `THREE` core (r128) is available — no examples/jsm modules (no OrbitControls, no BufferGeometryUtils, no Sky, no Water).
  Write what you need yourself.
- Renderer (created in main.js): `logarithmicDepthBuffer: true`, `outputEncoding = sRGBEncoding`, `ACESFilmicToneMapping`,
  shadow maps on (PCFSoft). Consequences:
  - Build every material color with `FS.color('#rrggbb')` (sRGB → linear). Never `new THREE.Color(hex)` directly for a material.
  - Canvas color textures: use `FS.textureFromCanvas(canvas)` (sets sRGB encoding, mipmaps, anisotropy). Data textures (roughness, alpha): `{linear:true}`.
  - Custom `ShaderMaterial`s must include `#include <logdepthbuf_pars_vertex>` / `<logdepthbuf_vertex>` / `<logdepthbuf_pars_fragment>` / `<logdepthbuf_fragment>`
    or they will z-sort wrongly. Prefer built-in materials + `onBeforeCompile` where possible. Sky domes should use `depthWrite:false, depthTest:false` and low renderOrder.
  - `InstancedMesh` frustum culling uses the base geometry's bounding sphere only: either set `mesh.frustumCulled = false` or give each chunk a cloned geometry with a `boundingSphere` covering its instances.
- Performance target: 60 fps on a laptop GPU. Keep draw calls low (batch, instance, merge). Total GPU texture memory under ~200 MB.
- Zero console errors. Guard against missing optional peers (`FS.city?.getObstacleTop`). Never throw during init; log and degrade.
- Do not touch files you don't own. Do not change `config.js`/`main.js`; if the contract is missing something you need, add it to your own module and document it at the top of your file.

## World frame and units
- `x` = east, `z` = south (**north is −z**), `y` = up. Meters, seconds, radians internally; the HUD displays knots / feet / ft·min⁻¹.
- Heading: compass degrees, 0 = north, 90 = east. `FS.geo.headingToDir(h)` → unit `{x,z}`; `FS.geo.dirToHeading(x,z)`.
- Aircraft body frame: forward = local **−Z**, up = +Y, right = +X. Heading `h` ⇔ yaw rotation about +Y of `FS.geo.headingToYaw(h)` radians.
- `FS.geo.toWorld(lat, lon)` → `{x,z}`. Origin 25.05 N / 121.52 E. Sea level y = 0. World covers ±36 km; the detailed
  "inner rect" is `FS.CONFIG.innerRect` (x −14..14 km, z −15..13 km) and contains the basin, Songshan, Yangmingshan, Guanyin Mt.
- Sun: `FS.CONFIG.sun` (azimuth 235° = light comes from the SW, elevation 34°). Airports, rivers, coast, mountains, parks,
  landmarks, CBD clusters: all in `FS.CONFIG` with world coordinates already computed.

## Init order (main.js) and the loop
```
FS.world.init(scene, renderer)   → heightmap + terrain meshes + sky/sun/fog/clouds ready; FS.world.getHeight usable
FS.city.init(scene)              → paints roads/blocks/parks onto the ground via FS.world.paintGround, builds buildings + obstacle grid
FS.airports.init(scene)          → paints airport grass/aprons, builds runways/taxiways/buildings/lights; getRunwayEnd usable
FS.aircraft.init(scene)          → aircraft mesh + physics; FS.aircraft.state populated
FS.nav.init(scene)               → guidance, gate rings, minimap renderer
FS.hud.init()                    → DOM overlay + HUD canvas + menus + audio
```
Each frame (only while `FS.game.running && !FS.game.paused` for the first two): `aircraft.update(dt)` → `nav.update(dt)` →
`airports.update(dt, state)` → `world.update(dt, camera, aircraftPos)` → `city.update(dt, cameraPos)` → camera →
`world.setShadowFocus(aircraftPos, cameraPos)` → `hud.update(dt)` → render → `input.endFrame()`.
`dt` is clamped to 50 ms. Physics must substep internally.

## Hotkey ownership (use `FS.input.wasPressed(code)` for one-shots, `isDown` for held; only when `FS.input.enabled`)
| Module | Keys |
|---|---|
| main.js | C, 1–4 camera modes (chase, cockpit, tower, flyby); P pause; R restart scenario; Escape menu (also releases mouse) |
| aircraft.js | W/S (pitch down/up), A/D (roll), Q/E (rudder), Arrow keys mirror WASD, Shift/Ctrl (throttle ±), PageUp/PageDown (throttle ±), mouse wheel (throttle), F (flaps cycle), B (brakes toggle), Space (brakes while held), mouse stick when `FS.input.mouse.active` |
| nav.js | L cycle landing target (runway ends, nearest first), N toggle guidance gates |
| hud.js | M minimap (off → 6 km → 20 km → 60 km range), H help overlay, K sound toggle, T toggle HUD |

Menus: `FS.game.openMenu()/closeMenu()` (main) set `FS.input.enabled` and pause; HUD's Start button calls `FS.game.start(id)`.

## Module APIs

### `FS.world` (js/world.js)
- `init(scene, renderer)`
- `getHeight(x, z)` → terrain elevation (m MSL). **0 on water**, ≥ 3 m on dry land in the basin, airports flattened to their `elev` over their whole footprint (runways + 300 m margin), 0 outside the world.
- `isWater(x, z)` → boolean (sea or river).
- `getNormal(x, z)` → `THREE.Vector3` (optional, for slope checks; callers may instead sample getHeight).
- `paintGround(fn)` → calls `fn(ctx, mapper)` once per ground canvas (inner 4096² and outer 2048²). The canvas transform is
  **pre-set so callers draw in world meters** (x east, z south, y-down canvas = south-down, i.e. north is up), and `lineWidth` etc. are in meters.
  `mapper = { rect:{x0,z0,x1,z1}, pxPerM, canvas, isInner }`. After all callbacks, textures are re-uploaded automatically (world calls `needsUpdate` at the end of `paintGround`).
- `getGroundCanvases()` → `[{canvas, rect, pxPerM}]` (for the minimap).
- `update(dt, camera, aircraftPos)` — clouds drift, sky dome follows camera.
- `setShadowFocus(aircraftPos, cameraPos)` — moves the directional-light shadow frustum; size scales with aircraft altitude (~400 m at ground level to ~3 km at altitude).
- `sunDir` — unit `THREE.Vector3` toward the sun; `sunLight` (DirectionalLight), `fog`, `skyColor`, `horizonColor`.
- `landLimits()` → `{minX,maxX,minZ,maxZ}` (world half size).

### `FS.city` (js/city.js)
- `init(scene)`
- `getObstacleTop(x, z)` → highest structure top (m MSL) within the 50 m cell containing (x,z) and its 8 neighbours, or `-Infinity`.
- `landmarks` → `[{name, x, z, top}]` (tallest first) — landmarks actually built.
- `update(dt, cameraPos)` (optional: ferris wheel rotation etc.)
- `setQuality(q)` (optional; rebuild for 'low'|'medium'|'high').

### `FS.airports` (js/airports.js)
- `init(scene)`
- `list` → airports: `{icao, name, x, z, elev, tower:{x,y,z}, runways:[...], ends:[...]}`.
- `getRunwayEnds()` → flat array of runway **ends** (one per landing direction):
  `{ key:'RCSS-10', icao, airportName, id:'10', heading (true deg, direction of landing/takeoff), dir:{x,z} (unit, along heading),
     threshold:{x,z}, oppositeThreshold:{x,z}, tdz:{x,z} (touchdown zone = threshold + 300 m), center:{x,z}, elev, length, width,
     spawn:{x,z,heading} (threshold + 150 m along the runway, on the centerline), papi:{x,z,side} }`
- `getRunwayEnd(key)` → end or `undefined`.
- `isOnRunway(x, z)` → the runway end whose rectangle contains the point (the end you'd land on given the point's nearer threshold is irrelevant — return the *first* end of that runway; callers use `.center/.dir`) or `null`.
- `isOnPaved(x, z)` → boolean (runway, taxiway, apron).
- `nearest(x, z)` → airport object.
- `update(dt, aircraftState)` — PAPI lights (red/white from the aircraft's actual glide angle to each PAPI), beacon flash.

### `FS.aircraft` (js/aircraft.js)
- `init(scene)`, `group` (THREE.Group, origin at the CG, forward −Z), `eyePoint` (Vector3, pilot's eye in local coords), `chaseOffset` (Vector3 local, e.g. (0, 4.5, 17)).
- `reset({x, z, heading, onGround, altitude, speed, throttle, flaps})` — altitude is m MSL (ignored when onGround: y = terrain + gear height). Clears crash state; emits `reset`.
- `update(dt)` — physics (substepped), control input, ground handling, terrain + building collisions, events.
- `state` (all fields updated every frame): `pos, vel` (Vector3, world), `quat`, `forward, up, right` (Vector3), `airspeed, groundSpeed` (m/s),
  `altitude` (m MSL), `agl` (m), `heading` (deg 0–360), `pitch` (deg, + nose up), `roll` (deg, + right wing down), `vs` (m/s, + up),
  `alpha, beta` (deg), `throttle` (0–1), `rpm`, `flaps` (0, 0.5, 1), `brakes` (bool), `onGround` (bool), `onRunway` (end|null),
  `crashed` (bool), `crashReason` (string), `stall` (bool), `gForce`, `terrainHeight`, `elevator, aileron, rudder` (−1..1), `mouseActive` (bool).
- `params`: `{ mass, wingArea, wingSpan, maxThrust, gearHeight, vSpeeds:{ rotate, approach, stall, stallFlaps, cruise, never } }` (m/s).
- Events: `touchdown {vs, speed, x, z, runwayEnd, crossTrack, alongFromThreshold, hard}`, `takeoff {runwayEnd}`, `crash {reason}`, `reset`.
- Input mapping rules: keyboard axes and mouse deflection **sum** and clamp to ±1. Mouse: `FS.input.mouse.x` → roll, `mouse.y` → pitch
  (cursor below center = nose UP by default — like pulling the stick — unless `FS.settings.invertMouseY`); apply `FS.settings.mouseSensitivity`
  and a 6 % dead zone. Keyboard: W = nose down, S = nose up (swap if `FS.settings.invertKeyPitch`).

### `FS.nav` (js/nav.js)
- `init(scene)`, `setTarget(end|null)`, `target`, `setPhase('takeoff'|'landing'|'free')`, `phase`, `autoTarget()` → nearest runway end,
  `cycleTarget()`, `gatesEnabled` (bool, N key).
- `update(dt)` — recompute `guidance`, update gate rings (pass detection → `gatePassed` event), auto phase transitions
  (takeoff → free once airborne and > 2 km from the runway; free → landing once within 15 km of target and roughly aligned).
- `guidance` (read by HUD): `{ target, phase, dist (m to threshold), bearing (deg), alongTrack, crossTrack (m, + right of centerline),
   locDev (deg, + = runway is to your right → fly right), gsDev (deg, + = above glideslope), desiredAlt (m MSL), altError, desiredHeading,
   headingError (deg, + turn right), onFinal, established, wp:{x,y,z,name} (steer-to point for the HUD arrow), gates:{total, passed, next},
   instruction (short text, e.g. 'Turn right to 096° · descend to 1,500 ft'), speedCue (m/s), papi:'RRWW' }`
- `drawMinimap(canvas, rangeMeters)` — north-up map: pre-rendered ground (from `FS.world.getGroundCanvases()`), runways, target approach path,
  gates, landmarks, aircraft icon with heading; called by HUD each frame the map is visible.

### `FS.hud` (js/hud.js)
- `init()` — injects its own CSS via a `<style>` element, creates the DOM overlay inside `#app` (above the canvas, `pointer-events:none`
  except for buttons/menus), the HUD `<canvas>`, minimap panel (`FS.hud.minimapCanvas`), menus, help, landing report, audio.
- `update(dt)` — draws HUD from `FS.aircraft.state` and `FS.nav.guidance`; drives audio; shows warnings (STALL, PULL UP, OVERSPEED, TERRAIN).
- `showStartMenu()`, `showMenu()`, `hideMenu()`, `isMenuOpen()`, `showMessage(text, ms)`, `showLandingReport(data)`, `showCrash(reason)`.
- Reads `FS.game.scenarios` (at show time) and calls `FS.game.start(id)`; settings UI mutates `FS.settings` + `FS.settings.save()`.
- Audio starts only after the first click (start button). `FS.settings.sound` gates it.

## Style
- Match `config.js`: 2-space indent, single quotes, semicolons, IIFE, comments only where the intent isn't obvious.
- Put a short header comment on top of your file listing what it exports and any additions to the contract.
- Real content, real names (Songshan, RCSS, runway 10/28, Tamsui, Keelung River, Taipei 101 …).
