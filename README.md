# Chartroom

Floor plans for Home Assistant: draw your home once, put your lights, switches, doors and windows
on it, and (soon) see temperature, humidity and Wi-Fi signal as live heatmaps over it — in a
sidebar panel and as a dashboard card.

> **Status: Phase 2 (devices) is complete.** Phase 1 gave the panel one tab per Home Assistant
> floor, pan and zoom, an optional underlay and an editor for walls, doors, windows, rooms and
> sensor/signal sources. Phase 2 adds live device markers in the panel and the card: tap to
> toggle, hold for details. Heatmaps come next (Phase 3); see
> [docs/render-design.md](docs/render-design.md) for how they will be rendered.

![Chartroom panel with device markers](docs/images/panel-devices.png)

## Drawing your plan

Open **Chartroom** in the sidebar, pick a floor and press **Edit** (or **Create plan** on a floor
without one). Admins only; changes save automatically.

![Chartroom editor](docs/images/editor.png)

- **Wall**: click to start, click to add corners, double-click or Esc to finish. Endpoints snap to
  other walls and stay joined when you drag them. Each wall has a material and a thickness.
- **Door** / **Window**: click on a wall. Width, swing and an optional open/closed entity are set
  in the inspector.
- **Room**: click the corners, double-click to close, then link the room to a Home Assistant area.
- **Source**: place a temperature/humidity sensor, a Wi-Fi access point or a radio (Zigbee,
  Z-Wave, Thread…). Sensors are picked from the Home Assistant temperature and humidity sensors in
  the plan's floor's areas; access points and radios take any entity and a level at 1 m. Drag to
  move, Delete to remove.
- **Underlay**: import a PNG, JPEG, WebP or SVG drawing to trace over, then calibrate the scale
  with **Measure** (two points and their real distance) or by a room's known area. In the panel
  outside the editor, the **Underlay** button and slider hide the drawing or change its opacity
  (just for you, not saved in the plan).
- **Device**: put lights, switches, fans, input booleans, covers, locks and binary sensors (doors,
  windows, motion…) on the plan. **Auto-place by area** drops every device whose area is linked to
  a room into that room; drag the rest from the list onto the plan (or pick one and click where it
  goes), then drag markers to where the devices really are. The inspector changes a marker's
  entity or deletes it. On a plan for a floor, the list only offers that floor's areas.
- **Undo** / **Redo**: Ctrl+Z and Ctrl+Shift+Z.
- **Materials**: the loss per centimetre for each wall material, used by the signal heatmap.
- The outer outline is worked out from the walls; there is no outline tool.
- A floor with more than 512 walls, 32 access points and radios or 256 devices shows a warning: the heatmaps
  may be slow on phones and tablets (see [docs/render-design.md](docs/render-design.md)).

![Placing sources in the editor](docs/images/editor-sources.png)

![Placing devices in the editor](docs/images/editor-devices.png)

![The panel with an underlay](docs/images/panel-underlay.png)

## Devices

Markers follow Home Assistant live, in the panel and in the card:

| Marker                              | Means                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| Amber disc                          | A light, switch, fan or input boolean is on               |
| Deep-orange disc                    | A door, window or garage door is open (or opening)        |
| Blue disc                           | Motion detected                                           |
| Purple disc                         | A cover is open, opening or closing                       |
| Red disc / green outline            | A lock is unlocked / locked                               |
| White disc                          | Off, closed or clear                                      |
| Dashed, faded disc with a red slash | Unavailable (unknown: dashed, no slash)                   |
| Dashed ring                         | Waiting for Home Assistant to confirm the change you made |

- **Tap** (or Enter/Space on a focused marker) toggles lights, switches, fans and input booleans,
  opens or closes a cover (stops it while it moves) and locks or unlocks a lock after you confirm.
  Sensors and unavailable devices open their details instead.
- **Hold** (half a second), right-click, the context-menu key or Shift+F10 opens Home Assistant's
  more-info dialog.
- Markers keep the same size on screen at any zoom. Each one is a button with its entity's name
  and state as its label, for screen readers.
- The glyphs are Chartroom's own small SVG line drawings. Home Assistant's `ha-state-icon` would
  have to sit in a `foreignObject` inside the zoomable SVG, which renders unreliably in WebKit
  (Safari and the iOS companion app), so Chartroom does not use it.

![Chartroom card](docs/images/card.png)

## Install (HACS)

1. In HACS, add this repository as a custom repository (category **Integration**).
2. Install **Chartroom** and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration → Chartroom**.

Chartroom adds a **Chartroom** entry to the sidebar and registers the
`custom:chartroom-card` card — no separate dashboard resource is needed:

```yaml
type: custom:chartroom-card
title: Ground floor
floor_id: ground_floor # or plan_id: example; without either, the first plan
height: 320px # optional; in the sections view the grid sets the height
```

The card shows the plan with live device markers (tap to toggle, hold for details). It does not
pan or zoom, so the dashboard still scrolls over it; open the panel to explore a plan.

Requires Home Assistant 2026.10 or newer. Chartroom has no Python requirements and no runtime
JavaScript dependencies; everything it needs ships in this repository.

## What's inside

| Path                                   | What                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `custom_components/chartroom/`         | The integration: config flow (single instance), plan storage, websocket API, panel, card. |
| `custom_components/chartroom/frontend` | Built frontend, committed so HACS can serve it. Do not edit by hand.                      |
| `frontend/src/`                        | `<chartroom-panel>` and `<chartroom-card>`: TypeScript Web Components, no framework.      |
| `.ci/configuration.yaml`               | The CI Home Assistant: template sensors, lights, switches, a lock and a cover for e2e.    |
| `tests/`, `frontend/test/`, `e2e/`     | pytest, Vitest, and Playwright against a real Home Assistant.                             |

Websocket commands: `chartroom/plans/list`, `chartroom/plans/get`, `chartroom/plans/save` and `chartroom/plans/delete` (save and delete need an admin). Underlay images live at `/api/chartroom/underlay/<plan_id>` (GET for any user, POST for admins; at most 10 MB).

## Example data

[![Example plan: two bedrooms, kitchen-living, bath and hall, about 62 m²](docs/images/example-plan.svg)](docs/images/example-plan.svg)

[`frontend/test/fixtures/example-plan.json`](frontend/test/fixtures/example-plan.json) is a real
one-floor flat of about 62 m², traced by hand into the plan model (`frontend/src/plan.ts`): walls in
metres with material and thickness, rooms, doors with their swing, windows, and sample
temperature/humidity sensors. Only the geometry and generic room types were kept; the source
drawing is not in the repository. Tests check each room against the area stated on the drawing.

```sh
pnpm example-plan                                   # regenerate the fixture and the SVG preview
HA_URL=http://127.0.0.1:8123 HA_TOKEN=... node scripts/example-plan/load-into-ha.mjs
```

The last command saves the fixture to a dev Home Assistant as plan `example` via
`chartroom/plans/save`.

## Development

Needs Node.js 24, pnpm and [uv](https://docs.astral.sh/uv/).

```sh
pnpm install
pnpm check          # format, lint, type-check (Vite+)
pnpm test           # Vitest
pnpm build          # builds into custom_components/chartroom/frontend — commit the result
pnpm size           # bundle-size budget

uv sync --group test --group lint --no-install-project
uv run ruff check . && uv run ruff format --check .
uv run pytest
```

End-to-end tests need a running Home Assistant with Chartroom copied into its
`custom_components`. They onboard a fresh instance, or use `HA_TOKEN` for an existing one:

```sh
pnpm exec playwright install chromium
HA_URL=http://127.0.0.1:8123 pnpm e2e
```

CI runs all of the above, plus hassfest and HACS validation, and starts Home Assistant in Docker
for the end-to-end tests.

## Credits and contact

Made by CaptainDuckay. Questions: hello@captains-chest.com.

## License

[MIT](LICENSE)
