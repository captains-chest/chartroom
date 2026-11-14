// The integration's websocket commands behind one port, so the viewer does not talk to Home
// Assistant's connection itself and its tests can hand it a fake.
import type { HassConnection, PlanSummary } from './ha-types';
import type { Topology } from './mesh-layer';
import { normalizePlan } from './plan/functions';
import type { Plan } from './plan/models';
import { ownUnderlayOnly } from './underlay-url';

/** What `chartroom/plans/subscribe` sends whenever a plan is saved or deleted. */
export interface PlanEvent {
  plan_id: string;
  deleted: boolean;
}

/** A loaded plan, and whether its stored underlay was dropped for not being the plan's own image. */
export interface LoadedPlan {
  plan: Plan;
  underlayIgnored: boolean;
}

export type Unsubscribe = () => Promise<void> | void;

export interface ChartroomApi {
  listPlans(): Promise<PlanSummary[]>;
  /** The stored plan, normalised, with an underlay only if it is the plan's own image. */
  getPlan(planId: string): Promise<LoadedPlan>;
  savePlan(planId: string, plan: Plan): Promise<void>;
  subscribePlans(cb: (e: PlanEvent) => void): Promise<Unsubscribe>;
  mesh(): Promise<Topology>;
  info(): Promise<{ version: string }>;
}

/** The port over Home Assistant's websocket connection. */
export function wsApi(c: HassConnection): ChartroomApi {
  const send = <T>(type: string, data?: object): Promise<T> =>
    c.sendMessagePromise<T>({ type: `chartroom/${type}`, ...data });
  return {
    listPlans: async () => (await send<{ plans: PlanSummary[] }>('plans/list')).plans,
    getPlan: async (plan_id) =>
      ownUnderlayOnly(plan_id, normalizePlan(await send('plans/get', { plan_id }))),
    // The storage id comes with a loaded plan; it is not part of what is saved.
    savePlan: async (plan_id, { id: _id, ...plan }: Plan & { id?: string }) => {
      await send('plans/save', { plan_id, plan });
    },
    subscribePlans: async (cb) => {
      if (!c.subscribeMessage) throw new Error('no subscriptions');
      return c.subscribeMessage(cb, { type: 'chartroom/plans/subscribe' });
    },
    mesh: () => send('mesh/get'),
    info: () => send('info'),
  };
}
