import type { AreaEntry, Hass, PlanSummary } from './ha-types';

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

export interface FloorTab {
  /** Stable key: `floor:<floor_id>` or `plan:<plan_id>`. */
  key: string;
  label: string;
  floor_id: string | null;
  /** The plan shown on this tab, if there is one yet. */
  plan_id: string | null;
}

/**
 * Tabs for the floor switcher: one per Home Assistant floor (by level) with the plan drawn for it,
 * then one per plan that belongs to no known floor.
 */
export function floorTabs(hass: Hass | undefined, plans: readonly PlanSummary[]): FloorTab[] {
  const floors = Object.values(hass?.floors ?? {})
    .slice()
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || byName(a, b));
  const sorted = plans.slice().sort((a, b) => a.id.localeCompare(b.id));
  const tabs: FloorTab[] = floors.map((f) => ({
    key: `floor:${f.floor_id}`,
    label: f.name,
    floor_id: f.floor_id,
    plan_id: sorted.find((p) => p.floor_id === f.floor_id)?.id ?? null,
  }));
  const known = new Set(floors.map((f) => f.floor_id));
  for (const p of sorted) {
    if (p.floor_id && known.has(p.floor_id)) continue;
    tabs.push({ key: `plan:${p.id}`, label: p.name, floor_id: null, plan_id: p.id });
  }
  return tabs;
}

/** Storage id for a new floor's plan: `floor_<floor_id>`, limited to safe characters. */
export const planIdForFloor = (floorId: string): string =>
  `floor_${floorId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`.slice(0, 64);

/** Areas for a room's area picker: the plan's floor first, then the rest, each by name. */
export function areaChoices(hass: Hass | undefined, floorId: string | null): AreaEntry[] {
  const areas = Object.values(hass?.areas ?? {});
  return areas
    .slice()
    .sort(
      (a, b) => Number(b.floor_id === floorId) - Number(a.floor_id === floorId) || byName(a, b),
    );
}
