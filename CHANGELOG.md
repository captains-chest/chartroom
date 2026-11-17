# Changelog

All notable changes to Chartroom. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Hovering a device marker, access point or radio with the mouse, or focusing a marker from the
  keyboard, shows a popover with the device's name and area and a line per entity: its state with
  unit and how long ago it changed, unavailable ones marked. It follows state changes while open,
  stays while the mouse is over it, and hides on leave, blur, Esc, a pan or a zoom; not on touch,
  and not in the editor. Markers no longer carry a native tooltip, which would cover it (#85).

### Changed

- A Home Assistant device is one marker on the plan, not one per entity: a temperature and
  humidity sensor is placed once (with **Device** in the editor, which now lists devices,
  temperature and humidity sensors among them) and feeds both the Temperature and the Humidity map
  from that spot, with one value label per map. Sensors are no longer sources; **Source** places
  access points and radios. A marker shows the device's light, switch, cover or lock if it has one,
  else its binary sensor, else its temperature or humidity. Entities without a device (helpers,
  template sensors) are placed on their own. Plans move to schema version 2: older plans open with
  their sensors as devices, those of one device placed within 1 m of each other as one marker
  between them, and are stored that way on the next save. Auto-place by area places sensors too
  (#84).

### Fixed

- Right-clicking a device marker now opens Home Assistant's more-info dialog, as a hold or the
  context-menu key does; it did nothing in the panel (#87).
- Releases no longer let an admin swap the real mesh for a made-up one: the e2e test hook
  `chartroom/mesh/test_source` is registered only when Home Assistant runs with the environment
  variable `CHARTROOM_TEST_HOOKS` set (#20).
- The card now catches up on plans saved while it was off the page (another dashboard view) or
  while Home Assistant was reconnecting, as the panel does; it kept showing the old plan (#81).

### Performance

- With the History slider open, the plan no longer redraws on every Home Assistant update while the
  shown time stays put: only moving the slider, loading another range or a change to the plan
  redraws it, as in live view (#82).
- A page with several Chartroom cards, or cards and the panel, runs one field worker instead of one
  per heatmap (plus a throwaway one each time the panel opened), and reads the mesh topology once a
  minute per Home Assistant connection instead of once per mesh layer. The poll stops when the last
  mesh layer is switched off or leaves the page (#80).

## 0.2.0 — 2026-11-16

### Fixed

- An open panel now follows plans saved elsewhere (another tab or user), as the card does: the
  plan on screen and its floor tabs update without a reload, and catch up after Home Assistant
  reconnects or the panel comes back on the page. While the editor is open it keeps its own copy;
  Done shows what is stored, and an edit made after a save elsewhere replaces it (the last save
  wins) (#78).
- **Done** no longer waits forever for an underlay image upload that hangs: after a minute it
  drops the upload, closes the editor and says so in the status line (#65).
- When the last change can't be saved as the editor closes (on **Done** or switching floors), the
  status line now says so, instead of the failure going away with the editor's toolbar (#66).
- The editor's inspector no longer replaces its fields whenever any Home Assistant state changes,
  which could drop a value still being typed in (say, a room name) before it was taken. Each panel
  is redrawn only when what it shows changes.
- A damaged stored plan (say, walls that are not a list, or a wall without an end) opens without
  the parts nothing can draw, instead of failing somewhere in the drawing code; what was left out is
  logged in the browser console, and the next save stores the plan without it.

### Performance

- A plan only redraws when something it shows changes: a state change of an entity the plan
  does not use (a light in another room) no longer rebuilds the heatmap's inputs, repaints the
  field or refreshes the layer buttons, in the panel and on every card. A reading that goes stale
  is still noticed on time.
- Dragging in the editor redraws the plan at most once a frame. While a wall, room, door or sensor
  is being dragged, the temperature and humidity fields keep their shape and are worked out again
  where the drag ends, instead of once per pointer move; the signal map still follows the drag.
- The last three underlay images are kept in the browser: Undo and Redo across an image change no
  longer download it again, and opening the editor while the panel is still loading the image
  waits for that load instead of starting a second one.

### Requirements

- Frontend: 16.66 KB gzip for the card, 57.26 KB gzip in total.

## 0.1.0 — 2026-11-14

The first release.

### Plans and the editor

- A sidebar panel with one tab per Home Assistant floor, pan and zoom, and a dashboard card
  (`custom:chartroom-card`) registered by the integration, with no separate resource to add.
- An editor for walls, rooms, doors, windows and sensor/signal sources, with undo, snapping and
  floor tabs. Plans are stored in Home Assistant and update open panels and cards live. Edits
  save a moment after each change, and at once when the page is hidden, closed or left; the
  browser asks before leaving while a change is still not stored. A save that fails (say, the
  connection dropped) is tried again by itself, after a wait that grows to 30 seconds or as soon as
  Home Assistant is back; one Home Assistant refuses is not.
- A home without Home Assistant floors gets one **Home** plan covering every area, with a link
  to create floors for one plan each.
- An optional underlay image per plan (uploaded by an admin, downscaled in the browser),
  calibrated against a known length or area. A plan's underlay can only be its own uploaded
  image: the integration refuses any other URL on save, and the panel never fetches one, so a
  plan can't send a user's token anywhere else. A plan stored earlier with another URL loads
  without its underlay, and admins see a short note asking them to import the image again. Undo
  brings back a replaced image, whether it was replaced in the underlay panel or by a plan import.
- A room can link more than one Home Assistant area, for open-plan spaces such as a kitchen and
  living room with no wall between them. Plans saved with one area per room load unchanged.
- Export a plan as a `.json` file, optionally with its underlay image embedded or saved as its own
  image file next to it, and import one (with that image file) over the current floor's plan.
  An image file the browser renamed on download is still taken when it is the only one picked
  and of the same type; when its type differs, the import says which type each is. Imports are
  checked and validated before anything is saved, and Undo brings the old plan back.

### Devices

- Live device markers for lights, switches, fans, input booleans, covers, locks and binary
  sensors (doors, windows): tap to toggle or open/close (locks after a confirm), hold for details.

### Heatmaps

- Temperature and humidity fields between your sensors. Heat travels through open doorways but
  never through walls or closed doors: distances are measured along paths through openings, so
  the colour blends smoothly across an open door, spreading from the doorway and fading into the
  far room, and changes sharply at a wall or closed door. A room without a sensor gets a fainter
  value through its doorways; a room nothing reaches is shown greyed as no data.
- An estimated Wi-Fi/radio signal map from your access points and radios, attenuated by walls.
  Beyond its limits (32 sources, 2048 wall segments) the legend and the editor say what the map
  leaves out.
- Zigbee (ZHA and Zigbee2MQTT) and Z-Wave JS mesh links drawn between devices, coloured by link
  quality.
- Rendered with WebGL2, with a Web Worker and a Canvas 2D fallback that give the same picture.

### History

- A history slider in the panel, and optionally on the card (`history: true`), that plays the
  plan back from the recorder. Marker colours fade between states while you scrub, and the card's
  device controls and layer counts follow the slider.

### Phones

- A phone layout for the panel with a compact history bar.

### Updates

- The frontend is served from a versioned path, and an open panel or card shows **Chartroom was
  updated** with a Reload button when the integration is newer than the page.

### Install

- Installs as a custom repository from the Marketplace (Home Assistant 2026.11 and newer), from
  HACS (2026.10), or by hand. Ships its own light and dark brand icon.

### Requirements

- Home Assistant 2026.10 or newer. No Python requirements and no runtime JavaScript
  dependencies. Frontend: 14.78 KB gzip for the card, 55.06 KB gzip in total.
