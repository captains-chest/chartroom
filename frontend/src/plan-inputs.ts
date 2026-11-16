// The one gate between Home Assistant's `hass` and what a plan shows. Home Assistant hands over a
// new `hass` on every state change anywhere in the house; a plan only reads the states of its own
// entities (sources, devices, doors and windows) and the registries. Everything that draws the plan
// asks `hassChanged` first, so a light toggling in a room the plan does not show costs nothing.
import type { Hass } from './ha-types';
import { planEntities } from './plan/functions';
import type { Plan } from './plan/models';

const inputs = new WeakMap<Plan, readonly string[]>();

/** The entity ids `plan` reads, each once (cached per plan object: plans are never mutated). */
export function planInputs(plan: Plan | null): readonly string[] {
  if (!plan) return [];
  let ids = inputs.get(plan);
  if (!ids) {
    const { sensors, others } = planEntities(plan);
    ids = [...sensors, ...others];
    inputs.set(plan, ids);
  }
  return ids;
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
