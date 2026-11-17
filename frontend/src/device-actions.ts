// What a device's wheel offers (device-menu.ts): a level per device with a segment per entity,
// and below each segment what that entity can do. Pure; loaded with the menu.
import { primaryEntity } from './device-entities';
import { deviceLook, deviceName, entityName, type Glyph, tapAction, words } from './devices';
import type { EntityState, Hass } from './ha-types';

const domainOf = (entityId: string): string => entityId.slice(0, entityId.indexOf('.'));

/**
 * What choosing a wheel segment does: call a service (maybe after confirming), show details, or
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

/** A segment's icon: an entity's glyph, or an action's. */
export type Icon =
  | Glyph
  | 'power'
  | 'brightness'
  | 'colour'
  | 'info'
  | 'route'
  | 'up'
  | 'down'
  | 'stop'
  | 'swing'
  | 'more';

/** A wheel segment: it acts, or opens a further level (`ring`) whose segments act or open one. */
export interface MenuItem {
  label: string;
  /** An entity's state ("21.4 °C"), or what an option is set to now ("75 %"): shown largest. */
  value?: string;
  icon?: Icon;
  /** The entity is unavailable or unknown: its value is shown faded. */
  unavailable?: boolean;
  /** A CSS colour shown as a dot instead of an icon (a light's colours). */
  swatch?: string;
  action?: MenuAction;
  ring?: readonly MenuItem[];
}

/** A level of the wheel, in order around it (clockwise from the top). */
export type Ring = readonly MenuItem[];

/** A level holds at most this many segments; the rest go to a More segment's level. */
export const MAX_RING = 8;
const WHITES: [string, number, string][] = [
  ['Warm white', 2700, '#ffc58f'],
  ['Neutral white', 4000, '#ffe4c4'],
  ['Cool white', 6500, '#eef3ff'],
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
  const call = (
    label: string,
    service: string,
    data?: Record<string, unknown>,
    look: Pick<MenuItem, 'icon' | 'swatch'> = {},
  ): MenuItem => ({
    label,
    ...look,
    action: { type: 'service', entity, domain, service, ...(data && { data }) },
  });
  const toggle = call('Toggle', 'toggle', undefined, { icon: 'power' });
  /** Percent steps under `label`, its value the current one (`now`, 0–100) when known. */
  const steps = (
    label: string,
    icon: Icon,
    values: number[],
    service: string,
    key: string,
    now?: number,
  ): MenuItem => ({
    label,
    icon,
    ...(now !== undefined && { value: `${Math.round(now)} %` }),
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
          .map(([label, k, swatch]) =>
            call(label, 'turn_on', { color_temp_kelvin: k }, { swatch }),
          ),
        ...(modes.some((m) => COLOUR_MODES.includes(m)) ? HUES : []).map(([label, hue]) =>
          call(label, 'turn_on', { hs_color: [hue, 100] }, { swatch: `hsl(${hue} 90% 55%)` }),
        ),
      ];
      const on = st.state === 'on' && typeof a.brightness === 'number';
      return [
        toggle,
        ...(modes.some((m) => m !== 'onoff')
          ? [
              steps(
                'Brightness',
                'brightness',
                [10, 25, 50, 75, 100],
                'turn_on',
                'brightness_pct',
                on ? (a.brightness! / 255) * 100 : undefined,
              ),
            ]
          : []),
        ...(colours.length ? [{ label: 'Colour', icon: 'colour', ring: colours } as const] : []),
      ];
    }
    case 'switch':
    case 'input_boolean':
      return [toggle];
    case 'fan': {
      const presets = f & FAN_PRESET ? (a.preset_modes ?? []) : [];
      const pct = a.percentage ?? undefined;
      return [
        toggle,
        ...(presets.length
          ? [
              {
                label: 'Speed',
                icon: 'fan',
                ...(a.preset_mode && { value: words(a.preset_mode) }),
                ring: presets.map((p) => call(words(p), 'set_preset_mode', { preset_mode: p })),
              } as const,
            ]
          : f & FAN_SPEED
            ? [steps('Speed', 'fan', [25, 50, 75, 100], 'set_percentage', 'percentage', pct)]
            : []),
        ...(f & FAN_OSCILLATE
          ? [
              call(
                a.oscillating ? 'Stop oscillating' : 'Oscillate',
                'oscillate',
                { oscillating: !a.oscillating },
                { icon: 'swing' },
              ),
            ]
          : []),
      ];
    }
    case 'cover':
      return [
        ...(f & COVER_OPEN ? [call('Open', 'open_cover', undefined, { icon: 'up' })] : []),
        ...(f & COVER_STOP ? [call('Stop', 'stop_cover', undefined, { icon: 'stop' })] : []),
        ...(f & COVER_CLOSE ? [call('Close', 'close_cover', undefined, { icon: 'down' })] : []),
        ...(f & COVER_POSITION
          ? [
              steps(
                'Position',
                'cover',
                [0, 25, 50, 75, 100],
                'set_cover_position',
                'position',
                a.current_position ?? undefined,
              ),
            ]
          : []),
      ];
    case 'lock': {
      // Lock or unlock, asking first as a tap does.
      const t = tapAction(entity, st);
      return t.type === 'service'
        ? [{ label: words(t.service), icon: 'lock', action: { ...t, entity } }]
        : [];
    }
    default:
      return [];
  }
}

/** `all` as a level: past MAX_RING, the last segment is More, a level with the rest. */
function fit(all: readonly MenuItem[]): Ring {
  // Every level below too: a light's colours, a fan's presets.
  const items = all.map((i) => (i.ring ? { ...i, ring: fit(i.ring) } : i));
  if (items.length <= MAX_RING) return items;
  const keep = items.slice(0, MAX_RING - 1);
  return [...keep, { label: 'More', icon: 'more', ring: fit(items.slice(MAX_RING - 1)) }];
}

/**
 * The wheel for a device item's `entities` (see `itemEntities`): a segment per entity, the marker's
 * first, each showing its state; one that can do something opens a level with what it can do and
 * its Details, any other (a sensor, an unavailable entity) opens its Details. A device with a
 * single entity skips that step: its level is what the entity can do, then its Details. Route
 * comes last when `route` (the Mesh layer is on and knows the device). Without `hass.callService`
 * (the History slider's past) nothing acts: every entity is a segment that opens its Details.
 */
export function deviceActions(
  entities: readonly string[],
  hass: Hass | undefined,
  route = false,
): Ring {
  const primary = primaryEntity(entities, hass);
  const ids = [primary, ...entities.filter((e) => e !== primary)];
  const live = !!hass?.callService;
  const details = (entity: string): MenuItem => ({
    label: 'Details',
    icon: 'info',
    action: { type: 'more-info', entity },
  });
  const routes: MenuItem[] = route
    ? [{ label: 'Route', icon: 'route', action: { type: 'route' } }]
    : [];
  const can = (e: string): MenuItem[] => (live ? entityItems(e, hass?.states?.[e]) : []);
  const own = ids.length === 1 ? can(primary) : [];
  if (own.length) return fit([...own, ...routes, details(primary)]);
  const device = deviceName(primary, hass?.entities?.[primary]?.device_id, hass);
  const segments = ids.map((e): MenuItem => {
    const look = deviceLook(e, hass?.states?.[e]);
    const items = can(e);
    return {
      label: entityName(e, device, hass),
      value: look.value,
      icon: look.glyph,
      ...((look.status === 'unavailable' || look.status === 'unknown') && { unavailable: true }),
      ...(items.length ? { ring: fit([...items, details(e)]) } : { action: details(e).action }),
    };
  });
  return fit([...segments, ...routes]);
}
