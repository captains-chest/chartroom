// An in-memory ChartroomApi for tests: plans in a map, and plan events on demand.
import type { ChartroomApi, PlanEvent } from '../src/api';
import type { PlanSummary } from '../src/ha-types';
import type { Topology } from '../src/mesh-layer';
import type { Plan } from '../src/plan/models';

export class FakeApi implements ChartroomApi {
  readonly plans = new Map<string, Plan>();
  topology: Topology = { nodes: [], links: [], sources: {} };
  version = '0.1.0';
  /** While set, `getPlan` waits for it: lets a test finish loads out of order. */
  gate: Promise<void> | null = null;
  readonly #listeners = new Set<(e: PlanEvent) => void>();

  async listPlans(): Promise<PlanSummary[]> {
    return [...this.plans].map(([id, p]) => ({ id, name: p.name, floor_id: p.floor_id ?? null }));
  }

  async getPlan(planId: string): Promise<Plan> {
    const gate = this.gate;
    if (gate) await gate;
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`no plan ${planId}`);
    return structuredClone(plan);
  }

  async savePlan(planId: string, plan: Plan): Promise<void> {
    this.plans.set(planId, structuredClone(plan));
    this.emit({ plan_id: planId, deleted: false });
  }

  /** Plans whose underlay images were pruned, in order. */
  readonly pruned: string[] = [];

  async pruneUnderlay(planId: string): Promise<void> {
    this.pruned.push(planId);
  }

  async subscribePlans(cb: (e: PlanEvent) => void): Promise<() => void> {
    this.#listeners.add(cb);
    return () => void this.#listeners.delete(cb);
  }

  async mesh(): Promise<Topology> {
    return this.topology;
  }

  async info(): Promise<{ version: string }> {
    return { version: this.version };
  }

  emit(e: PlanEvent): void {
    for (const cb of this.#listeners) cb(e);
  }
}
