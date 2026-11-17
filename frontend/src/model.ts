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

/** Storage id of the plan for a home without floors: one plan covering every area. */
export const HOME_PLAN_ID = 'home';

/** The one tab of a home with no floors and no plans yet, so a first plan can still be made. */
export const HOME_TAB: FloorTab = {
  key: `plan:${HOME_PLAN_ID}`,
  label: 'Home',
  floor_id: null,
  plan_id: null,
};

/**
 * Tabs for the floor switcher: one per Home Assistant floor (by level) with the plan drawn for it,
 * then one per plan that belongs to no known floor. With no floors and no plans, the home tab.
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
  // Only once the floor registry has loaded, so a home with floors never flashes the home tab.
  return tabs.length === 0 && hass?.floors ? [{ ...HOME_TAB }] : tabs;
}

/** Storage id for a new plan on a tab without one: the floor's, or the home plan's. */
export const newPlanId = (tab: FloorTab): string =>
  tab.floor_id ? planIdForFloor(tab.floor_id) : HOME_PLAN_ID;

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

/** The area an entity is in: its own, else its device's. */
export function entityArea(hass: Hass | undefined, entityId: string): string | null {
  const e = hass?.entities?.[entityId];
  if (!e) return null;
  if (e.area_id) return e.area_id;
  return (e.device_id && hass?.devices?.[e.device_id]?.area_id) || null;
}

export interface EntityChoice {
  entity_id: string;
  name: string;
  area_id: string | null;
}

/**
 * Entities to place as an access point or radio: any entity (its state says whether it is up). On a
 * plan with a floor, only entities in that floor's areas.
 */
export function sourceChoices(hass: Hass | undefined, floorId: string | null): EntityChoice[] {
  const areas = hass?.areas ?? {};
  const onFloor = (area: string | null): boolean =>
    !floorId || (area !== null && areas[area]?.floor_id === floorId);
  const out: EntityChoice[] = [];
  for (const st of Object.values(hass?.states ?? {})) {
    const area = entityArea(hass, st.entity_id);
    if (!onFloor(area)) continue;
    out.push({
      entity_id: st.entity_id,
      name: st.attributes.friendly_name ?? st.entity_id,
      area_id: area,
    });
  }
  return out.sort((a, b) => byName(a, b) || a.entity_id.localeCompare(b.entity_id));
}
