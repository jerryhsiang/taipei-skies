# Taipei Skies

A browser flight simulator over Taipei. Fly a Cessna 172 with your mouse or WASD across a procedurally rebuilt
Taipei basin, and take off from or land at Songshan (RCSS) and Taoyuan (RCTP) with ILS-style guidance.

**Play it:** https://jerryhsiang.github.io/taipei-skies/

No install, no build step, no backend: one HTML page, eight plain JavaScript files and Three.js r128 from a CDN.
Everything else — terrain, rivers, 70,000 buildings, landmarks, airports, the aircraft, the sounds — is generated
in code when the page loads (about two seconds).

## What's in the world

- **Geography from real coordinates.** Latitude/longitude of the basin, rivers, coast, mountains, parks and
  landmarks are converted to meters (origin 25.05 N, 121.52 E). The Tamsui, Keelung, Xindian and Dahan rivers,
  the estuary and north coast, Yangmingshan, Guanyin Mountain, the Nangang range and Linkou plateau are all where
  they belong. The world is 72 km across; the basin is modelled at ~27 m resolution.
- **A city that reads as Taipei from the air.** Thirteen district street grids (central Taipei axis-aligned with
  Zhongxiao, Ren'ai, Xinyi, Dunhua, Fuxing…; Shilin, Beitou, Neihu, Banqiao, Sanchong, Zhonghe/Yonghe, Xinzhuang
  rotated like the real ones), riverside floodplain parks, elevated expressways, Daan Forest Park, the NTU campus.
  Buildings are instanced boxes with per-lot floor counts, weathered roofs, rooftop sheds and water tanks, and a
  procedural window shader. High-rise clusters follow the real CBDs (Xinyi, Taipei Main Station, Neihu, Nangang,
  Banqiao).
- **Landmarks:** Taipei 101 (508 m, eight stacked segments and spire), Nan Shan Plaza, Shin Kong Life Tower,
  Taipei Main Station, the Presidential Office, CKS Memorial Hall, the Grand Hotel, Sun Yat-sen Memorial Hall,
  Taipei Dome, Taipei Arena, the Miramar ferris wheel (it turns), Nangang Exhibition Center, New Taipei City Hall
  and the Banqiao Mega Tower, plus twelve bridges including Guandu Bridge's red arches.
- **Two airports.** Songshan 10/28 downtown and Taoyuan 05L/23R and 05R/23L on the coastal plain, with runway
  markings painted to scale (piano keys, designators, aiming points, touchdown-zone stripes, rubber deposits),
  taxiways, aprons, terminals, control towers, parked airliners in EVA, China Airlines and Starlux liveries,
  edge/threshold/approach lights, windsocks, rotating beacons and PAPI lights that go red/white with your
  actual glide angle.
- **Atmosphere.** Late-afternoon sun from the south-west, humid haze, cumulus over the mountains, a cirrus veil,
  glossy water, sun shadows around the aircraft, ACES tone mapping.

## Flying

| Input | Action |
|---|---|
| Click the view | Engage the mouse stick: cursor offset from center = roll and pitch (cursor below center pulls the nose up). Esc, X or right-click releases. |
| W / S, ↑ / ↓ | Pitch down / up |
| A / D, ← / → | Roll left / right |
| Q / E | Rudder (nose-wheel steering on the ground) |
| Shift / Ctrl, PageUp / PageDown, mouse wheel | Throttle |
| F | Flaps 0° → 15° → 30° |
| B, Space | Brakes (toggle / hold) |
| C, 1–4 | Camera: chase, cockpit, tower, fly-by |
| L | Choose the runway to land on (nearest first) |
| N | Show / hide the guidance rings |
| M | Minimap range: off → 6 km → 20 km → 60 km |
| H | Help, including a landing primer |
| P, R, Esc | Pause, restart the scenario, menu |

Mouse and keyboard inputs add together, so you can use either or both.

### Taking off
Hold Shift to full throttle. At 55 kt (the cyan V<sub>R</sub> mark on the airspeed tape) hold S for about a
second, then let go: the aircraft trims itself into a climb. Follow the cyan departure rings.

### Landing
Press L to pick a runway. The magenta steer marker and the instruction strip route you to a 10 km final; from
there the localizer and glideslope diamonds, the rings along the 3° glidepath and the PAPI (two white, two red
means on slope) bring you to the threshold. Aim for 65 kt with full flaps, idle over the numbers, ease the nose
up, and you get a graded report card: sink rate, centerline offset, distance past the threshold.

### Scenarios
Take off from Songshan 10 or 28 or Taoyuan 05L · airborne over Taipei 101 or Yangmingshan · final approach to
Songshan or Taoyuan from 6 nm.

## Flight model
A 6-degree-of-freedom-lite model of a 1,100 kg Cessna 172: lift and drag from angle of attack and sideslip
with a smooth stall, ground effect, flap and sideslip drag, propeller thrust that falls off with speed, static
stability, rate damping, dihedral, adverse yaw and auto-coordination. It is tuned to be flyable from a keyboard:
an auto-trim follows 1 g at the current speed, an angle-of-attack limiter keeps a sustained pull at the stall
edge instead of looping, and a gentle wings-level assist eases the bank out when you let go. Wheels contact the
terrain individually; a hard touchdown bounces, a very hard one (below about −1,300 ft/min), a steep slope,
water or a building ends the flight.

## Code layout

```
index.html        page shell and loading screen
js/config.js      constants, geography in world meters, geo helpers, seeded simplex noise, input, events, settings
js/world.js       heightmap, terrain meshes, ground textures, sky, sun, fog, clouds, shadows
js/city.js        street grids, ground painting, instanced buildings, landmarks, bridges, trees, obstacle grid
js/airports.js    runways, taxiways, aprons, buildings, airliners, lights, PAPI, windsocks
js/aircraft.js    Cessna 172 model, flight physics, input mapping, ground handling, collisions
js/nav.js         ILS-style guidance, steer-to waypoints, gate rings, phase logic, minimap
js/hud.js         head-up display, menus, landing report, procedural engine and wind audio
js/main.js        renderer, init sequence, game loop, cameras, scenarios
CONTRACT.md       the module contract the parts were written against
test/             standalone harnesses for each module and headless physics / navigation tests
```

World frame: x east, z south, y up, meters. Heading 0° is north; the aircraft's forward axis is local −Z.

## Running locally
Serve the folder over HTTP (the page fetches its scripts, so `file://` won't do):

```bash
python3 -m http.server 8000
```

then open http://localhost:8000/. Headless tests need Node:

```bash
node test/aircraft-physics.js
node test/nav-math.js
```

`test/*.html` are per-module viewers (aircraft turntable, airport fly-over, city orbit, HUD bench, world view).
`build-artifact.sh` produces a version of the page without the document skeleton for hosts that wrap pages
themselves.

## How it was made
Designed and built with Claude Code: six agents worked in parallel, one per module, against a shared contract,
with subagents for the aircraft model, landmarks, runway painter, minimap and audio; the lead integrated,
play-tested in a browser and fed fixes back.
