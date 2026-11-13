// Linking a room to Home Assistant areas, for the room inspector.
import type { Hass } from '../ha-types';

/** An area's name, or its id when Home Assistant no longer has it. */
export const areaName = (hass: Hass | undefined, areaId: string): string =>
  hass?.areas?.[areaId]?.name ?? areaId;

/**
 * A room's name after its linked areas change from `before` to `after` (area names): the room takes
 * the areas' names ("Kitchen & Living room") while it still has its default name ("Room 3") or the
 * name it took from them last time. A name of the user's own is kept. Unlinking the last area gives
 * a name taken from the areas back as `defaultName`, so linking an area again renames the room.
 */
export function roomNameForAreas(
  name: string,
  before: readonly string[],
  after: readonly string[],
  defaultName: string,
): string {
  if (/^Room \d+$/.test(name)) return after.length > 0 ? after.join(' & ') : name;
  if (before.length === 0 || name !== before.join(' & ')) return name;
  return after.length > 0 ? after.join(' & ') : defaultName;
}
