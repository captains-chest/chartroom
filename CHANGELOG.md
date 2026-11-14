# Changelog

All notable changes to Chartroom. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 — unreleased

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
  dependencies. Frontend: 14.78 KB gzip for the card, 54.83 KB gzip in total.
