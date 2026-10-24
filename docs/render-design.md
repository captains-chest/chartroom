# Render design (Phase 0 notes)

How Chartroom paints live layers (temperature, humidity, signal) onto the floor plan. Written in
Phase 0 so that Phase 1's plan and wall model carries what Phases 3 and 4 need.

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

Two layer families use two different models.

## Temperature and humidity: linear interpolation between sensors

The value at a point is a **linear interpolation between the sensor points around it**. Two rooms
at 25 °C and 30 °C give exactly 27.5 °C halfway between the sensors, changing evenly along the
line. No blobs, no plateaus around sensors, no inverse-distance weighting.

Per floor, with `n` sensors that report a fresh numeric value:

| Sensors                    | Field                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0                          | No layer.                                                                                                                                                                                                                                    |
| 1                          | Flat: the one value everywhere.                                                                                                                                                                                                              |
| 2, or all (near-)collinear | **Segment mode**: project the point onto the line through the sensors, lerp between the two neighbouring sensors along it, clamp beyond the ends.                                                                                            |
| 3 or more, not collinear   | **Triangulated**: Delaunay triangulation of the sensor positions, barycentric interpolation inside each triangle; outside the convex hull, project onto the nearest hull edge and lerp along that edge (at a hull vertex, the vertex value). |

- **Triangulation**: our own Bowyer-Watson in TypeScript, no libraries, in the worker. Robust
  orientation tests with an epsilon relative to the plan size; if the hull area is below a
  threshold (near-collinear set) or triangulation fails, fall back to segment mode. Duplicate
  positions are merged (mean value).
- **GPU drawing**: the triangles are drawn as a mesh with the sensor value as a per-vertex
  attribute, so the rasteriser's linear interpolation _is_ the barycentric interpolation, at no
  cost per pixel.
- **Outside the hull**: a **fan of extension geometry** built on the CPU at triangulation time:
  for each hull edge, a quad extruded outward perpendicular to the edge, with each outer vertex
  carrying the value of the edge endpoint it came from (so the value only varies along the edge
  direction: exactly "project to the nearest edge and lerp"); for each hull vertex, a wedge
  between the neighbouring quads with the constant vertex value. Extruded far enough to cover the
  plan bounds plus the outside margin. This needs no extra shader pass. (The alternative, a
  fragment-shader pass that loops over hull edges per pixel, is the fallback if the geometry
  approach shows artefacts.)
- **Re-triangulate only when sensors move, appear or disappear.** A value update only rewrites
  the per-vertex value buffer.
- **Walls do not bend temperature or humidity.** The shader and worker keep a disabled hook
  (`wallInfluence = 0`) so a later mode could attenuate interpolation across walls without
  changing the pipeline.
- **Confidence / staleness**: a sensor that is stale or unavailable is dropped from the set
  (which triggers a re-triangulation); the layer fades where the nearest sensor is far away.

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

## Pipeline

```
Phase 1 plan model                 worker / main thread                 GPU (WebGL2)
------------------                 --------------------                 ------------
sensors: entity, pos, floor   ->   Bowyer-Watson, hull, extension   ->  VBO: positions (static until
                                   fan (on add/move/remove only)        sensors move) + value
sensor states (hass)          ->   eased per-vertex values          ->  VBO: values (per update)
                                                                        draw mesh -> R32F field target
walls: a, b, thickness, mat   ->   pack + resolve loss_db           ->  sampler2D uWalls
access points: pos, tx, PL0   ->   uniforms                         ->  fragment pass: rays x walls,
                                                                        max over APs -> R32F target
                                                                    ->  colour pass: ramp texture,
                                                                        confidence, outside fade,
                                                                        bilinear upscale -> canvas
                                                                        under the SVG plan
```

- **Two passes**: pass 1 writes the scalar field into a float target; pass 2 maps it through
  the colour ramp, applies confidence and the outside fade (from the plan outline) and draws it.
  Ramp, opacity and theme changes never recompute the field.
- **Colour ramp**: a 256x1 texture, `blue -> cyan -> green -> yellow -> red`, with a per-layer
  domain (for example 16–28 °C, 30–70 %, -90 to -40 dBm). Being a texture, themes and
  colour-blind-safe ramps are a data change.
- **SVG stays on top**: walls, rooms, labels and device markers remain SVG for crisp lines, hit
  testing and accessibility. The canvas is only the field.

## Live transitions

- Each sensor or access point keeps `from`, `to` and a start time. A `requestAnimationFrame`
  loop eases the value (about 600 ms, ease-out) and re-uploads only the value buffer (temperature,
  humidity) or the access-point uniforms (signal). Geometry and the wall texture are untouched.
- When sensors are added or removed, the old and new fields cross-fade instead of popping.
- The loop stops when nothing is moving, so an idle plan costs nothing.

## Performance budget

- **Temperature and humidity** cost almost nothing per pixel: a small mesh rasterised once per
  animation frame. The cost is triangulation, `O(n log n)` to `O(n^2)` for tens of sensors, and it
  only runs when sensors move.
- **Signal** costs roughly `pixels x access points x walls` ray tests per frame. Render pass 1 at
  **lower resolution** (about 1/4 of the canvas per axis, at most 512 px on the long side) and let
  bilinear upscaling in pass 2 smooth it; walls stay sharp because they are SVG. Example: 256x256,
  8 access points, 200 walls is about 105 M simple tests, fine on desktop GPUs and mid-range
  phones, and it only runs while values change.
- **Limits**: soft caps of 512 wall segments and 32 access points per floor, with an editor
  warning above them. Optional culling of walls by bounding box per access point.
- Measure on old wall tablets in Phase 3 (WebGL2 availability, float render targets, fill rate)
  before raising caps.

## Canvas2D fallback

When WebGL2 or float render targets are unavailable, the **Web Worker** computes the same fields
on the same low-resolution grid with the same formulas (barycentric / segment / hull-edge lerp for
temperature and humidity, rays and wall loss for signal) and posts back a `Float32Array` of value
and confidence. The main thread maps it through the same ramp into an `ImageData` and draws it
scaled with smoothing. The TypeScript code is also the reference the shaders are tested against
(Vitest for the maths, Playwright pixel checks for the shaders).

The worker stub that ships in Phase 0 (`frontend/src/worker.ts`) already has the message protocol.

## As built in Phase 3

The temperature and humidity layers follow this note, with these differences:

- **Outside the hull: a shader pass, not an extension fan.** The owner asked for the
  nearest-hull-edge projection to run as its own shader pass, so pass 1a is a full-grid fragment
  pass that loops over the hull edges per cell (and, in the same pass, computes confidence and the
  outside fade). Pass 1b then rasterises the Delaunay triangles over it, writing the value channel
  only. The fan above is not built. With tens of sensors the loop is a few dozen edges per cell on
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
  outline the layer drops to 45 % and fades out over 2.5 m.
- **Staleness** uses `last_reported` (older than 6 h is stale) when Home Assistant sends it.
  Unavailable, unknown and non-numeric sensors are left out, shown as a dashed marker label, and
  counted in the legend.
- **Transitions**: each sensor value eases over 600 ms (ease-out cubic) and pass 1 reruns per
  frame while anything moves; a new sensor layout cross-fades from the previous field target in
  the colour pass. With `prefers-reduced-motion` both are instant.

The underlay image, if any, sits above the heat canvas.

## What Phase 1 must provide

- Plan coordinates in **metres**, from the plan scale.
- **Walls as segments** (`a`, `b`) that always carry **thickness** and a **material** (id into a material table
  with a default dB loss per cm or per wall, editable).
- **Openings** (doors, windows) attached to a wall with their own material and an optional entity
  for open/closed state.
- **Sources** placed on the plan with a floor: entity id, position, kind (`sensor`,
  `access_point`, `radio`), and for radios a transmit power / reference loss.
- A **plan outline** (exterior polygon) so the outside fade knows what is inside.
- Stable ids for walls and sources so the GPU buffers can be updated in place.

## What Phase 4 adds

- Per-source radio parameters from ZHA, Z-Wave JS and Zigbee2MQTT (link quality, RSSI, which
  coordinator or router), plus mesh links drawn in SVG.
- Calibration: fit `n` and per-material losses to measured RSSI where enough sensors exist.
- The decision point for moving the worker maths to Rust/WebAssembly, if the TypeScript
  fallback is too slow on phones.
