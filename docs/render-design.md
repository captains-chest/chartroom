# Render design

How Chartroom paints live layers (temperature, humidity, signal) onto the floor plan. It started
as Phase 0 notes, written so that Phase 1's plan and wall model carries what Phases 3 and 4 need.
The "As built" sections record where the build went another way and win where the two differ.
"How it is built" is the short version of the current design.

## The look

The reference we work from (not in this repo) is a Wi-Fi survey heatmap over a house drawing:

- The field is **continuous, per pixel, across the whole plan**, not one flat colour per room.
- Colour runs **blue -> cyan -> green -> yellow -> red** (red is hot / strong).
- Neighbouring sources **blend into one surface**; there are no seams between them.
- The field is **live**: when a value changes, the surface animates smoothly to the new state.
- It **extends outside the house**, faded, so the plan sits in context instead of in a box.
- For signal, each access point is a **red hotspot** falling off with distance, and walls
  **attenuate** it by material and thickness rather than hard-clipping it.

The plan Page mockup (one flat fill per room) is a simplified stand-in. It neither interpolates
between sensors nor casts rays; this document replaces it as the rendering target.

## How it is built

- **Temperature and humidity**: inverse path-distance weighting over the nearest three sensors a
  cell can reach without crossing a wall or a closed door (see "As built: walls are boundaries").
- **Signal**: straight rays from each source, losing dB at each wall by material and thickness;
  the strongest source wins (see "As built in Phase 4").
- **Outside the outline**: signal shows at 45 % and fades to nothing over 2.5 m (`OUTSIDE_ALPHA`
  and `FADE_DISTANCE` in `field.ts`). Temperature and humidity show no colour there, only the
  no-data grey at 35 % of that fade.
- **SVG stays on top**: walls, rooms, labels and device markers remain SVG for crisp lines, hit
  testing and accessibility. The canvas under them is only the field, and the underlay image sits
  under the canvas.
- **Colour ramp**: 256 RGBA entries (`rampLut`) with a per-layer domain: 16–28 °C, 30–70 %, -90
  to -30 dBm. Being a lookup table, themes and colour-blind-safe ramps are a data change, and
  ramp, opacity and theme changes never recompute the field.

The seams, under `frontend/src/`:

- `heat-layer.ts` (a lazy chunk) picks the sensors for the active layer, asks the worker to plan
  a new layout, eases values and cross-fades layouts. It draws through a **`FieldRenderer`**
  (`heat/models.ts`) with two implementations:
  - `heat/gl-renderer.ts` (WebGL2): a weights pass for temperature and humidity, or `SIGNAL_FS`
    for signal, writes value, confidence and fade into an RGBA32F target; a colour pass draws it.
  - `heat/canvas-renderer.ts` (Canvas2D): the worker fills the same grid and the page colours it
    into an `ImageData`, scaled up with smoothing.

  The legend and the sensor value labels live in `heat/legend.ts` and `heat/value-labels.ts`.

- The worker (`worker.ts`, messages in `worker-protocol.ts`) runs `planField` (`field-plan.ts`)
  when the layout changes, and `fillField` / `signalField` for the Canvas2D renderer.
  `heat/field-client.ts` talks to it and runs the same handler in the page when workers are
  unavailable. Nothing the worker loads touches the DOM; `pnpm size` checks that.
- `viewer.ts` **`ViewerController`** is what the panel and the card share around the plan view:
  the layer buttons, the History slider, the hass the plan shows, loading a plan, and releasing
  the view's layers while the element is off the page.
- `api.ts` **`ChartroomApi`** is the port to the integration's websocket commands, so the viewer
  never talks to Home Assistant's connection itself and its tests hand it a fake.
- The editor (`plan-editor.ts`, a lazy chunk) keeps its pure parts in `editor/`: the tools as
  pure steps (`tools.ts`), snapping (`snap.ts`), how to find, delete and drag each kind of item
  (`kinds.ts`) and the autosaver (`autosaver.ts`). The plan schema and its operations live in
  `plan/`.

```
plan + hass                  main thread                             worker
-----------                  -----------                             ------
sensors, walls, doors,  ->   heat-layer.ts: layout key changed?  ->  planField: barriers,
door/window states                                                   visibility, path distances,
                                                                     per-cell weights
sensor states           ->   eased values (600 ms)
                             |
                             v
                             FieldRenderer
                             - WebGL2: weights pass or SIGNAL_FS  -> RGBA32F field target
                                       -> colour pass -> canvas under the SVG plan
                             - Canvas2D: values to the worker    ->  fillField / signalField
                                       <- field grid -> ImageData -> canvas
```

The Phase 0 notes follow. Two layer families use two different models.

## Temperature and humidity: the Phase 0 plan (superseded)

Phase 0 planned a **linear interpolation between the sensor points around a point**, with no
inverse-distance weighting: a Delaunay triangulation of the sensors (our own Bowyer-Watson),
barycentric interpolation inside each triangle, the nearest hull edge outside the hull, segment
mode for two or (near-)collinear sensors and a flat field for one. Phase 3 shipped that on the
GPU (see "As built in Phase 3").

It was replaced when walls became boundaries. The field is now inverse path-distance weighting
over the nearest three sensors (see "As built: walls are boundaries"). Two sensors in one open
room still give exactly 27.5 °C halfway between 25 °C and 30 °C; with three or more sensors it is
no longer the Delaunay plane.

What is left of the plan:

- `buildMesh` in `field.ts` still merges sensors closer than 1 mm into one node (mean value). It
  still triangulates to choose the layout's mode (`none`, `flat`, `segment`, `mesh`), which the
  e2e checks read; in segment mode it projects the nodes onto their line. The linear
  interpolation itself is gone.
- A value update only re-mixes the node values. The layout is planned again only when sensors,
  walls or door and window states change; a stale or unavailable sensor leaves the set, which
  plans again.

## Signal: straight rays from each access point

For each pixel `p` and access point `s` (position, transmit power or reference loss):

1. `d = |p - s.pos|` in metres (plan scale).
2. Cast the straight ray `s.pos -> p` and test it against **every wall segment**. For each wall it
   crosses, add that wall's loss: `A += loss_db(material, thickness)` (for example
   `material.db_per_cm * thickness_cm`, or a per-material table with a thickness factor). Doors and
   windows are openings in a wall with their own loss, open or closed.
3. Received signal: log-distance path loss
   `rx = tx - (PL0 + 10 n log10(max(d, d0) / d0)) - A`.
4. Combine access points: **max** over access points (the one a device would use).

- Implemented in our own **WebGL2 fragment shader**. Walls live in an RGBA32F texture, two texels
  per wall: `(ax, ay, bx, by)` and `(thickness, loss_db, kind, opening_state)`. Access points are a
  uniform block of `vec4(x, y, tx, pl0)` (a texture above 64).
- Ray vs segment is the usual 2D cross-product test; a hit when both parameters are in `[0, 1]`.
  Loss is read from the texel, so materials cost no branching.
- `n` (path-loss exponent, about 2–3 indoors), `PL0` at `d0 = 1 m` and the material table are
  tunable; Phase 4 can fit them to measured RSSI.
- Geodesic distance fields (Dijkstra / fast marching around walls) are **not** part of this
  design.

## Live transitions

- Each sensor or access point keeps `from`, `to` and a start time. A `requestAnimationFrame`
  loop eases the value (about 600 ms, ease-out) and re-uploads only the value buffer (temperature,
  humidity) or the access-point uniforms (signal). Geometry and the wall texture are untouched.
- When sensors are added or removed, the old and new fields cross-fade instead of popping.
- The loop stops when nothing is moving, so an idle plan costs nothing.

## Performance budget

- **Temperature and humidity** cost is in planning (path distances over the grid), which runs in
  the worker only when the layout changes. Per frame, the weights pass mixes at most three node
  values per cell.
- **Signal** costs roughly `cells x sources x walls` ray tests per trace. It is traced on a fixed
  low-resolution grid (at most 128 cells on the long side; temperature and humidity use 256) and
  bilinear upscaling in the colour pass smooths it; walls stay sharp because they are SVG.
  Example: 128 x 128 cells, 8 access points, 200 walls is about 26 M simple tests, fine on desktop
  GPUs and mid-range phones, and it only runs when the input changes.
- **Limits**: a soft cap of 512 walls per floor (an editor warning that it may be slow) and
  hard caps of 32 sources and 2048 wall segments, the shader's uniform array and texture row.
  Beyond the hard caps the signal map uses the first ones and leaves out the rest: the editor
  warns and the legend says how many were left out. Per-source culling of walls by bounding box
  is not done yet.
- The measurements are under "Old-wall-tablet check" below.

## Canvas2D fallback

When WebGL2 or float render targets are unavailable, the **Web Worker** computes the same fields
on the same grid with the same formulas (`fillField` in `field-plan.ts` mixes the planned weights
for temperature and humidity; `signalField` in `signal.ts` traces rays with wall loss) and posts
back a `Float32Array` of value, confidence and fade. The main thread maps it through the same
ramp into an `ImageData` and draws it scaled with smoothing. The TypeScript code is also the
reference the shaders are tested against (Vitest for the maths, Playwright checks for the
shaders).

The worker is `frontend/src/worker.ts`, with its messages in `worker-protocol.ts`.

## As built in Phase 3

The temperature and humidity layers followed this note, with these differences. The first two
bullets are superseded: "As built: walls are boundaries" replaced the hull pass and the triangle
pass with one weights pass.

- **Outside the hull: a shader pass, not an extension fan.** The owner asked for the
  nearest-hull-edge projection to run as its own shader pass, so pass 1a is a full-grid fragment
  pass that loops over the hull edges per cell (and, in the same pass, computes confidence and the
  outside fade). Pass 1b then rasterises the Delaunay triangles over it, writing the value channel
  only. The extension fan Phase 0 planned is not built. With tens of sensors the loop is a few dozen edges per cell on
  a grid of at most 256 cells per side, so the cost is small.
- **Barycentric weights in the fragment shader.** Each triangle vertex carries its triangle's
  three node indices; the fragment computes the weights from the node positions and mixes the
  node values (positions and values in a small float texture). Letting the rasteriser
  interpolate a per-vertex value varying gave visible drift (up to 0.1 % of the range) in the long
  thin triangles along the hull, where the gradient is steep. With exact weights the GPU and the
  CPU reference agree to about 4e-6 °C on 99.9 % of the cells; the odd cell whose centre falls on
  a triangle edge differs by up to 0.2 % of the range.
- **Field target RGBA32F** (value, confidence, fade) rather than R32F, so pass 2 does no geometry.
  The worker's Canvas2D fallback produces the same three channels.
- **Confidence**: 1 within 3 m of a sensor, easing to 0.3 at 8 m (smoothstep). Outside the
  outline the layer dropped to 45 % and faded out over 2.5 m; temperature and humidity now show
  only the no-data grey there.
- **Staleness** uses `last_reported` (older than 6 h is stale) when Home Assistant sends it.
  Unavailable, unknown and non-numeric sensors are left out, shown as a dashed marker label, and
  counted in the legend.
- **Transitions**: each sensor value eases over 600 ms (ease-out cubic) and pass 1 reruns per
  frame while anything moves; a new sensor layout cross-fades from the previous field target in
  the colour pass. With `prefers-reduced-motion` both are instant.

The underlay image, if any, sits **beneath** the heat canvas (its own SVG layer under the
canvas), so the field tints the drawing instead of being hidden by it. Value labels next to sensor
markers are decluttered: a label that would overlap a room name moves below its marker, and one
that still overlaps (small cards) is hidden; the marker keeps its accessible name.

## As built in Phase 4

### Signal

- **Model** (`frontend/src/signal.ts`, the reference): for each cell and source,
  `rx = level_at_1m - 10 n log10(max(d, 1 m)) - sum(wall losses)`, then the max over sources.
  `n = 2.2`, floor -120 dBm. `level_at_1m` is the source's `tx_dbm` (default -40 dBm for an access
  point, -45 dBm for a radio), so `PL0` is folded into it. A source whose entity is unavailable is
  left out.
- **Walls** are split at their openings: wall parts lose `db_per_cm x thickness_cm` of the wall's
  material, each door or window its own material's loss, and an opening whose entity is `on`,
  `open`, `opening` or `closing` loses nothing. Zero-loss parts are dropped. The result is
  `(ax, ay, bx, by, loss)` per segment, so the shader needs one RGBA32F texel pair per segment
  (row 0 the endpoints, row 1 the loss) and no material table.
- **Shader**: one full-grid fragment pass (`SIGNAL_FS` in `heat/gl-renderer.ts`) writes value,
  confidence (always 1) and the outside fade into the same RGBA32F field target as the other
  layers, and the same colour pass draws it. Access points are `uniform vec4 uAps[32]`. Per
  source it starts from the free-space level, skips the source if that is already below the best
  so far, and stops testing walls as soon as it drops below the best, which keeps the average far
  under `cells x sources x walls`. The intersection test (`t in (0, 1]`, `u in [0, 1]`) is identical in
  GLSL and TypeScript.
- **Resolution**: a fixed grid of at most 128 cells on the long side, bilinear upscaled. Walls are
  SVG on top, so the field does not need to be sharp.
- **Canvas2D fallback**: the worker runs `signalField` on the same grid and posts the field back.
- **Agreement** (e2e, example plan with an access point, a radio and 31 wall segments, 13 696
  cells): WebGL2 against the worker, max difference 7.6e-6 dB, no cell over the tolerance.
- **Fixed domain** -90 to -30 dBm on a violet, red, amber, yellow-green, green ramp; no value
  labels (a level at 1 m is not a reading). The legend counts sources and wall segments.
- Not done: calibration (fitting `n` and losses to measured RSSI), per-source radio parameters
  from the integrations, per-source bounding-box culling.

### Mesh links

- The integration (`mesh.py`) reads ZHA (its gateway's devices and neighbour tables), Z-Wave JS
  (each node's last working route through its repeaters, with RSSI) and Zigbee2MQTT
  (`bridge/request/networkmap` over MQTT, at most every 10 minutes, since a scan loads the network) with the standard library and Home Assistant only.
  Each source reports `ok`, `absent`, `pending` or `error`; a missing integration is `absent`, not
  an error. `chartroom/mesh/get` returns `{nodes, links, sources}`; nodes carry the Home
  Assistant device id and entities when known.
- The panel layer (`mesh-layer.ts`, its own lazy chunk, loaded on first use) places a node where a
  device marker shows its device (or one of its entities) or a source one of its entities, and draws a
  line for each link with both ends on the plan: hue from red (bad) to green (good) by LQI/255, or
  by RSSI from -90 to -40 dBm; dashed grey when unknown. It re-reads every 60 s while on.
- `chartroom/mesh/test_source` (admin) swaps in a fake topology, in memory only, for e2e. It is
  registered only when Home Assistant runs with `CHARTROOM_TEST_HOOKS` set, as the e2e one does.

### Old-wall-tablet check

There is no wall tablet in CI, so this approximates one: headless Chrome at 1280 x 800, DPR 1,
`prefers-reduced-motion` (no transition frames), Chrome DevTools CPU throttling 4x and 6x, on an
8-core Xeon box. WebGL2 is SwiftShader (software Vulkan), i.e. a CPU rasteriser in the GPU process;
CDP throttling slows the page's main thread but neither that GPU process nor the Web Worker.
`PERF=1 pnpm e2e e2e/perf.spec.ts` reproduces it.

Worst case at the soft caps: 512 wall segments, 32 sources (16 x 12 m of 1 m cells). Retrace =
move one source, wait for the new field to be drawn and read back; median (p90), 12 runs.

| CPU slowdown | WebGL2 retrace | Worker retrace | Pan frames (WebGL2 / worker) |
| ------------ | -------------- | -------------- | ---------------------------- |
| 1x           | 138 ms (155)   | 246 ms (257)   | 60 / 60 fps                  |
| 4x           | 181 ms (202)   | 246 ms (250)   | 47 / 55 fps                  |
| 6x           | 175 ms (196)   | 241 ms (245)   | 38 / 39 fps                  |

The same check with the 32 sources as temperature sensors (wall-aware field with doorways,
planned again on every move): 78 / 81 ms at 1x, 156 / 135 ms at 4x, 206 / 182 ms at 6x (WebGL2 /
worker, median).

A realistic flat (64 segments, 4 sources) at 6x: 50 ms (62) retrace with either renderer, 38-43 fps
while panning (the frame cost is the SVG and the colour pass, not the field).

Reading it:

- A retrace happens only when a source moves, a door opens or a source goes unavailable, never per
  frame; panning and zooming only redraw the colour pass.
- The worker is not throttled here, so on a CPU 6x slower than this box expect about
  `6 x 245 ms ~ 1.5 s` for the worst case in the Canvas2D fallback, and about 0.1 s for a realistic
  flat. It runs off the main thread, so the panel stays responsive; the old field stays up until
  the new one arrives.
- **Rust/WebAssembly decision: not needed.** The fallback is within budget for realistic plans and
  only slow at the caps on slow CPUs, where a straight port to WASM would buy perhaps 1.5-3x on
  this scalar float loop. Cheaper wins come first: per-source bounding-box culling, a uniform grid
  of walls so a ray only tests the cells it crosses, and tracing at 64 cells first and refining.
  Revisit only if a real tablet without WebGL2 shows multi-second retraces on a plan under the
  caps.

## As built: walls are boundaries, doorways are not (temperature and humidity)

Owner decision: the temperature and humidity field must not blend through walls. The colour
changes sharply at a wall instead of smearing across it.

- **Barriers** (`barrierSegments` in `signal.ts`): every wall part always blocks. A door blocks
  only while its entity is closed (`off`/`closed`); a window blocks unless its entity is open
  (`on`/`open`/`opening`/`closing`). Doors without an entity, unknown states and gaps in walls let
  the field through. Walls are drawn on their centre lines, so two walls meeting at a corner can
  leave a sliver between the line ends; each wall end is joined to any wall within half their
  thicknesses plus 5 cm by a short extra barrier segment to the nearest point on it.
- **Visibility** (`visibility` in `field-plan.ts`): whether the straight ray between a cell and a
  sensor crosses no barrier. For each sensor and barrier the shadow behind the segment is a convex
  quad, filled row by row over the outline's bounding box (widened by 1e-4 cells so neighbouring
  shadows leave no gap).
- **Owner decision (revised): heat travels through doorways.** An earlier rule ("a room with its
  own sensors uses only those") stepped at the room line even at an open doorway. Now a cell may
  use any sensor reachable along a path that passes only through openings (open doors, gaps,
  doors without an entity or with an unknown state, open windows), never through a wall or a
  closed door.
- **Path distances** (`planField`): a multi-label Dijkstra over the grid keeps, per cell, the four
  nearest (sensor, path distance) labels. Steps go to 16 neighbours (orthogonal, diagonal and
  knight moves; the longer moves only where the cells they cut through are open and inside). A
  cell that sees the sensor directly gets the exact straight-line distance, so open space is not
  bent by the grid; others get the parent's distance plus the step. Barrier cells take a label
  but pass none on. This is the "portal" idea worked out on the grid: the shortest path round a
  door jamb is the geodesic pixel -> doorway -> sensor.
- **Weights**: `w = exp(-e / 1 m - h / 1.5 m) / max(cell / 2, d)`, where `d` is the path
  distance, `e = d - straight distance` is the detour round corners, and `h` is how far the path
  has come since it left the sensor's room (tracked through the search, using the room
  polygons). The three heaviest labels are mixed, each less the fourth's weight, so a sensor
  drops out smoothly. In one open room `e = h = 0` and this is plain inverse distance: exactly
  linear between two sensors (27.5 °C halfway between 25 and 30). With three or more sensors it
  is inverse distance over the nearest three, not the Delaunay plane used before.
- **Why one rule for every sensor**: blending directly visible sensors linearly and adding
  sensors from other rooms on top cannot be continuous where a door jamb's shadow line falls or
  at the room line. Weighting every sensor by its path distance is continuous everywhere a path
  is; a wall or closed door has no path through it, so it stays a sharp edge. The detour term
  keeps the wall beside an open door sharp (the value on the far side had to go round), and the
  `h` term makes the next room fade back to its own sensors with distance from the doorway.
- **Doorway check** (unit tests, 10 x 4 m box split by a wall with a 1 m door, 20 °C and 30 °C):
  mid-doorway 25.0, no step larger than 0.3 °C per cell across it; closed door and wall step
  20 -> 30; the cool room's influence in the warm room shrinks with distance from the door.
- **Confidence**: `near(nearest path distance) x (1 - 0.4 x share of the value that came round a
  corner)`, so values through a doorway are paler. A cell no path reaches has no data.
- **No data**: a cell nothing reaches is drawn grey (no colour) at low opacity, never a colour that
  leaked through a wall; a closed-off room with no sensor looks like this.
- **Outside the house: faded no-data.** Outside the outline there is no colour, only a faint grey
  halo fading over 2.5 m. Sourcing outdoor values through windows was considered and left out:
  an indoor reading says little about the garden.
- **Where it runs**: the plan (per cell: up to three node indices and weights, confidence, fade)
  is worked out in the Web Worker whenever sensors, barriers or door/window states change; a new
  reading only re-mixes values. The WebGL2 path uploads the plan as a texture and a weights pass
  mixes the node values per cell; the colour pass colours the four neighbouring cells first and
  then interpolates, so a wall stays a sharp edge rather than a blurred mid-colour. The Canvas2D
  fallback colours each cell the same way and smooths. The e2e agreement test still compares the
  two (field max diff about 2e-6 °C, pixel max diff 18/255 at edges).
- **Bundling**: the worker is a build entry (`workers/worker.js`) sharing chunks with the lazy
  in-page fallback, so the field code ships once. `pnpm size` checks that nothing the worker loads
  touches the DOM.
- **Cost** (planning on this box, 256 x 208 cells, a 16 x 12 grid of rooms with doors, 192
  rooms): 8 sensors 288 ms, 32 sensors 350 ms, 128 sensors 524 ms, 256 sensors 702 ms (the
  visible-set planner it replaced: 61 / 282 / 2219 / 3328 ms on the same plan). Planning runs only
  when sensors, walls or door states change. The throttled e2e check at the soft caps is under
  "Old-wall-tablet check".

## Devices feed the heatmaps

Since plan schema version 2 a temperature or humidity sensor is a **device item** (`plan.devices`),
not a source, and a device item stands for a Home Assistant device rather than one entity:

- An item has `entity_id` (the entity it was placed by, shown while the registry does not know the
  device) and, for an entity that has a device, `device_id`. Its entities are its own `entity_id`
  and the rest of the device's in `hass.entities`, without hidden and config/diagnostic ones, less
  any placed as items of their own (`itemEntities` in `device-entities.ts`, cached per plan and
  registry object). Helpers and template sensors have no device: their item is the one entity.
- `layerData` takes, for each item, the first of its entities whose class fits the layer
  (`layerOfState`): a multisensor's temperature feeds Temperature and its humidity Humidity, both
  at the item's position, with the item's id as the reading id. So there is one value label per
  active layer per device, drawn above its marker (`VALUE_OFFSET_PX` in `labels.ts`).
- The marker shows the item's primary entity (`primaryEntity`): one it can control, else a binary
  sensor, else a temperature, then humidity, then other sensor.
- Hovering a marker (mouse or pen, after 400 ms) or focusing it from the keyboard
  (`:focus-visible`) shows a popover (`device-popover.ts`, `.device-popover`, in the plan box) with
  the device's name, area and a line per item entity (`popoverContent`), the primary first. It is
  the marker's `aria-describedby` while shown (markers have no `<title>`, whose native tooltip
  would cover it), refreshes on every new `hass` (`PointerDelegate.statesChanged`) and every 30 s,
  follows the marker when the view moves, and hides on a press elsewhere, a wheel, blur or Esc.
  Touch never shows it: a touch hold has its own job (more-info; the radial menu of #86). Sources (access points, radios) get it on
  hover too.
- `planInputs` (which states a plan reads) and the History slider's entity list resolve items the
  same way, so they take the registry along with the plan.
- **Migration**: `normalizePlan` turns a version 1 plan's `sensor` sources into device items with
  the same id and position (no registry needed, so a plan still loads before `hass` has one). The
  registry part, `foldDevices`, runs where the plan meets `hass`: `PlanView.setPlan` (and again
  when the registry changes) for what is shown, and the editor when it opens a plan or imports a
  file, so the next save stores it (an editor opened before the registry came folds its plan and
  undo history when it does, without saving). Items that name an entity of a device but not the
  device get `device_id`: the first of a device and those linked to it by steps of at most 1 m
  (`FOLD_M`, on the positions as placed) become one item at their mean position (the first one's
  id and entity). The device's other items, and those of a device an item already names, stay on
  their own as single-entity items, so folding a folded plan returns it unchanged.

## What Phase 1 must provide

- Plan coordinates in **metres**, from the plan scale.
- **Walls as segments** (`a`, `b`) that always carry **thickness** and a **material** (id into a material table
  with a default dB loss per cm or per wall, editable).
- **Openings** (doors, windows) attached to a wall with their own material and an optional entity
  for open/closed state.
- **Sources** placed on the plan with a floor: entity id, position, kind (`sensor`,
  `access_point`, `radio`), and for radios a transmit power / reference loss. Since schema version
  2, temperature and humidity sensors are **device items** instead (see "Devices feed the
  heatmaps"); `sources` holds access points and radios.
- A **plan outline** (exterior polygon) so the outside fade knows what is inside.
- Stable ids for walls and sources so the GPU buffers can be updated in place.

## What Phase 4 adds

- Per-source radio parameters from ZHA, Z-Wave JS and Zigbee2MQTT (link quality, RSSI, which
  coordinator or router), plus mesh links drawn in SVG. The mesh links shipped; the radio
  parameters did not (see "As built in Phase 4").
- Calibration: fit `n` and per-material losses to measured RSSI where enough sensors exist.
- The decision point for moving the worker maths to Rust/WebAssembly, if the TypeScript
  fallback is too slow on phones. Decided: not needed (see "Old-wall-tablet check").
