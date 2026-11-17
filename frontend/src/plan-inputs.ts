// The one gate between Home Assistant's `hass` and what a plan shows. Home Assistant hands over a
// new `hass` on every state change anywhere in the house; a plan only reads the states of its own
// entities (devices and their Home Assistant device's entities, sources, doors and windows) and the
// registries. Everything that draws the plan
// asks `hassChanged` first, so a light toggling in a room the plan does not show costs nothing.
import { planEntities } from './device-entities';
import type { Hass } from './ha-types';
import type { Plan } from './plan/models';

const inputs = new WeakMap<Plan, { entities: Hass['entities']; ids: readonly string[] }>();

/**
 * The entity ids `plan` reads, each once, with `hass`'s entity registry (which says what a device
 * item's entities are). Cached per plan and registry object: neither is ever mutated.
 */
export function planInputs(plan: Plan | null, hass: Hass | undefined): readonly string[] {
  if (!plan) return [];
  let cached = inputs.get(plan);
  if (!cached || cached.entities !== hass?.entities) {
    const { sensors, others } = planEntities(plan, hass);
    cached = { entities: hass?.entities, ids: [...sensors, ...others] };
    inputs.set(plan, cached);
  }
  return cached.ids;
}

/** The parts of `hass` every plan depends on, whatever its entities: registries and connection. */
const SHARED = ['entities', 'devices', 'areas', 'floors', 'connection', 'user'] as const;

/**
 * Whether going from `prev` to `next` changes anything a plan reading `ids` shows: one of its
 * entities' state objects (Home Assistant replaces the object when the state changes) or a
 * registry. Compared by identity, so it costs one lookup per entity.
 */
export function hassChanged(
  prev: Hass | undefined,
  next: Hass | undefined,
  ids: readonly string[],
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  for (const k of SHARED) if (prev[k] !== next[k]) return true;
  if (prev.states === next.states) return false;
  for (const id of ids) if (prev.states?.[id] !== next.states?.[id]) return true;
  return false;
}
