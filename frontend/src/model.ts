import type { AreaEntry, Hass } from './ha-types';

export interface FloorGroup {
  id: string | null;
  name: string;
  level: number | null;
  areas: AreaEntry[];
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** Group Home Assistant areas under their floors: floors by level, areas by name, unassigned last. */
export function groupAreasByFloor(hass: Hass | undefined): FloorGroup[] {
  const floors = Object.values(hass?.floors ?? {});
  const areas = Object.values(hass?.areas ?? {});
  const groups: FloorGroup[] = floors
    .slice()
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || byName(a, b))
    .map((f) => ({
      id: f.floor_id,
      name: f.name,
      level: f.level,
      areas: areas
        .filter((a) => a.floor_id === f.floor_id)
        .slice()
        .sort(byName),
    }));
  const known = new Set(floors.map((f) => f.floor_id));
  const loose = areas
    .filter((a) => !a.floor_id || !known.has(a.floor_id))
    .slice()
    .sort(byName);
  if (loose.length > 0) groups.push({ id: null, name: 'No floor', level: null, areas: loose });
  return groups;
}

/** A stable key so elements only re-render when floors or areas actually change. */
export function floorsKey(groups: FloorGroup[]): string {
  return JSON.stringify(groups.map((g) => [g.id, g.name, g.areas.map((a) => [a.area_id, a.name])]));
}
