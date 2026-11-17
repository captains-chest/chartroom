// What a device's radial menu offers (device-menu.ts): ring 1 with ring 2 inside its items, from
// the device's entities, their domains and what they support. Pure; loaded with the menu.
import { primaryEntity } from './device-entities';
import { deviceName, entityName, tapAction, words } from './devices';
import type { EntityState, Hass } from './ha-types';

const domainOf = (entityId: string): string => entityId.slice(0, entityId.indexOf('.'));

/**
 * What choosing a radial-menu item does: call a service (maybe after confirming), show details, or
 * show the device's mesh route (never acts on it).
 */
export type MenuAction =
  | {
      type: 'service';
      entity: string;
      domain: string;
      service: string;
      data?: Record<string, unknown>;
      confirm?: string;
    }
  | { type: 'more-info'; entity: string }
  | { type: 'route' };

/** A radial-menu item: it acts, or (in ring 1 only) opens ring 2, whose items act. */
export interface MenuItem {
  label: string;
  action?: MenuAction;
  ring?: readonly MenuItem[];
}

/** A ring of the radial menu, in order around the marker (clockwise from the top). */
export type Ring = readonly MenuItem[];

/** Ring 1 holds at most this many items; entities past it are left to Details. */
export const MAX_RING = 8;
const WHITES: [string, number][] = [
  ['Warm white', 2700],
  ['Neutral white', 4000],
  ['Cool white', 6500],
];
const HUES: [string, number][] = [
  ['Red', 0],
  ['Orange', 30],
  ['Yellow', 55],
  ['Green', 120],
  ['Blue', 230],
  ['Purple', 280],
];
const COLOUR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];
// supported_features bits (Home Assistant's FanEntityFeature, CoverEntityFeature).
const FAN_SPEED = 1;
const FAN_OSCILLATE = 2;
const FAN_PRESET = 8;
const COVER_OPEN = 1;
const COVER_CLOSE = 2;
const COVER_POSITION = 4;
const COVER_STOP = 8;

/** What one entity can do, for the menu: nothing when it is unavailable or only reads. */
function entityItems(entity: string, st: EntityState | undefined): MenuItem[] {
  if (!st || st.state === 'unavailable' || st.state === 'unknown') return [];
  const domain = domainOf(entity);
  const a = st.attributes;
  const f = a.supported_features ?? 0;
  const call = (label: string, service: string, data?: Record<string, unknown>): MenuItem => ({
    label,
    action: { type: 'service', entity, domain, service, ...(data && { data }) },
  });
  const steps = (label: string, values: number[], service: string, key: string): MenuItem => ({
    label,
    ring: values.map((v) => call(`${v} %`, service, { [key]: v })),
  });
  switch (domain) {
    case 'light': {
      const modes = a.supported_color_modes ?? [];
      const colours = [
        ...(modes.includes('color_temp') ? WHITES : [])
          .filter(
            ([, k]) =>
              k >= (a.min_color_temp_kelvin ?? 0) && k <= (a.max_color_temp_kelvin ?? Infinity),
          )
          .map(([label, k]) => call(label, 'turn_on', { color_temp_kelvin: k })),
        ...(modes.some((m) => COLOUR_MODES.includes(m)) ? HUES : []).map(([label, hue]) =>
          call(label, 'turn_on', { hs_color: [hue, 100] }),
        ),
      ];
      return [
        call('Toggle', 'toggle'),
        ...(modes.some((m) => m !== 'onoff')
          ? [steps('Brightness', [10, 25, 50, 75, 100], 'turn_on', 'brightness_pct')]
          : []),
        ...(colours.length ? [{ label: 'Colour', ring: colours }] : []),
      ];
    }
    case 'switch':
    case 'input_boolean':
      return [call('Toggle', 'toggle')];
    case 'fan': {
      const presets = f & FAN_PRESET ? (a.preset_modes ?? []) : [];
      return [
        call('Toggle', 'toggle'),
        ...(presets.length
          ? [
              {
                label: 'Speed',
                ring: presets.map((p) => call(words(p), 'set_preset_mode', { preset_mode: p })),
              },
            ]
          : f & FAN_SPEED
            ? [steps('Speed', [25, 50, 75, 100], 'set_percentage', 'percentage')]
            : []),
        ...(f & FAN_OSCILLATE
          ? [
              call(a.oscillating ? 'Stop oscillating' : 'Oscillate', 'oscillate', {
                oscillating: !a.oscillating,
              }),
            ]
          : []),
      ];
    }
    case 'cover':
      return [
        ...(f & COVER_OPEN ? [call('Open', 'open_cover')] : []),
        ...(f & COVER_STOP ? [call('Stop', 'stop_cover')] : []),
        ...(f & COVER_CLOSE ? [call('Close', 'close_cover')] : []),
        ...(f & COVER_POSITION
          ? [steps('Position', [0, 25, 50, 75, 100], 'set_cover_position', 'position')]
          : []),
      ];
    case 'lock': {
      // Lock or unlock, asking first as a tap does.
      const t = tapAction(entity, st);
      return t.type === 'service' ? [{ label: words(t.service), action: { ...t, entity } }] : [];
    }
    default:
      return [];
  }
}

/**
 * The radial menu for a device item's `entities` (see `itemEntities`), ring 1 with ring 2 inside
 * its items: what the marker's entity can do, then an item per other entity (opening a ring with
 * what that one can do and its Details, or its Details alone), then Route when `route` (the Mesh
 * layer is on and knows the device), then Details. Items the entity does not support are left out;
 * an unavailable device has (Route and) Details only.
 */
export function deviceActions(
  entities: readonly string[],
  hass: Hass | undefined,
  route = false,
): Ring {
  const primary = primaryEntity(entities, hass);
  const details = (entity: string): MenuItem => ({
    label: 'Details',
    action: { type: 'more-info', entity },
  });
  const end: MenuItem[] = [
    ...(route ? [{ label: 'Route', action: { type: 'route' } } as const] : []),
    details(primary),
  ];
  const st = hass?.states?.[primary];
  if (!st || st.state === 'unavailable' || st.state === 'unknown') return end;
  const ring = entityItems(primary, st);
  const device = deviceName(primary, hass?.entities?.[primary]?.device_id, hass);
  for (const e of entities) {
    if (e === primary || ring.length >= MAX_RING - end.length) continue;
    // Ring 2 only acts: what opens a further ring (brightness steps) is left to the entity's Details.
    const own = entityItems(e, hass?.states?.[e]).filter((i) => !i.ring);
    const label = entityName(e, device, hass);
    ring.push(own.length ? { label, ring: [...own, details(e)] } : { ...details(e), label });
  }
  return [...ring, ...end];
}
