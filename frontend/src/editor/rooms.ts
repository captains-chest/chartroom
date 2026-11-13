// Linking a room to Home Assistant areas, for the room inspector.
import type { Hass } from '../ha-types';

/** An area's name, or its id when Home Assistant no longer has it. */
export const areaName = (hass: Hass | undefined, areaId: string): string =>
  hass?.areas?.[areaId]?.name ?? areaId;

/**
 * A room's name after its linked areas change from `before` to `after` (area names): the room takes
 * the areas' names ("Kitchen & Living room") while it still has its default name ("Room 3") or the
 * name it took from them last time. A name of the user's own is kept, and so is any name once the
 * last area is unlinked.
 */
export function roomNameForAreas(
  name: string,
  before: readonly string[],
  after: readonly string[],
): string {
  const adopted = /^Room \d+$/.test(name) || name === before.join(' & ');
  return adopted && after.length > 0 ? after.join(' & ') : name;
}
