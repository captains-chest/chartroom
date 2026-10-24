# Changelog

All notable changes to Chartroom. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 — unreleased

The first release.

### Plans and the editor

- A sidebar panel with one tab per Home Assistant floor, pan and zoom, and a dashboard card
  (`custom:chartroom-card`) registered by the integration, with no separate resource to add.
- An editor for walls, rooms, doors, windows and sensor/signal sources, with undo, snapping and
  floor tabs. Plans are stored in Home Assistant and update open panels and cards live.
- An optional underlay image per plan (uploaded by an admin, downscaled in the browser),
  calibrated against a known length or area.

### Devices

- Live device markers for lights, switches, fans, input booleans, covers, locks and binary
  sensors (doors, windows): tap to toggle or open/close (locks after a confirm), hold for details.

### Heatmaps

- Temperature and humidity fields between your sensors. Walls are boundaries: a point only takes
  a value from sensors it can see past walls and closed doors, so the colour changes sharply at a
  wall. Open doors, gaps and open windows let values through. A room without a sensor gets a
  fainter value through its doorways; a room nothing reaches is shown greyed as no data.
- An estimated Wi-Fi/radio signal map from your access points and radios, attenuated by walls.
- Zigbee (ZHA and Zigbee2MQTT) and Z-Wave JS mesh links drawn between devices, coloured by link
  quality.
- Rendered with WebGL2, with a Web Worker and a Canvas 2D fallback that give the same picture.

### History

- A history slider in the panel, and optionally on the card (`history: true`), that plays the
  plan back from the recorder. Marker colours fade between states while you scrub.

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
  dependencies. Frontend: 16.3 KB gzip for the card, 49.2 KB gzip in total.
