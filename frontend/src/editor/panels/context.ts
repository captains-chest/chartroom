// What an inspector panel is given: the plan as it is when a control is used, the Home Assistant
// state it was built with, and a way to change the plan. Panels are functions from these (and
// their own inputs) to elements; the editor decides which to show and when to rebuild them.
import type { Hass } from '../../ha-types';
import { materialsOf } from '../../plan/functions';
import type { Plan } from '../../plan/models';
import { h } from '../../ui';

export interface PanelContext {
  /** The plan now (read when a control is used, not only when the panel was built). */
  readonly plan: Plan;
  readonly hass: Hass | undefined;
  /** Make `plan` the plan: an undoable change, saved soon. */
  commit(plan: Plan): void;
}

/** A panel's fields, under the title and above the Delete button its section adds. */
export type Fields = (HTMLElement | null)[];

/** A titled inspector section (`data-panel` names it for tests). */
export const section = (
  title: string,
  kind: string,
  ...children: (HTMLElement | null)[]
): HTMLElement => h('section', { 'data-panel': kind }, h('h2', {}, title), ...children);

/** The plan's materials as picker options. */
export const materialOptions = (plan: Plan): { value: string; label: string }[] =>
  [...materialsOf(plan).values()].map((m) => ({ value: m.id, label: m.name }));
