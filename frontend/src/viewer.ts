// What the panel and the card share around the plan view: the layer buttons, the History slider
// (loaded on first use), the hass the plan shows, loading, following and saving a plan, the
// underlay image, and releasing the view's layers while the element is off the page.
import { wsApi, type ChartroomApi, type LoadedPlan, type PlanEvent, type Unsubscribe } from './api';
import type { Hass, HassConnection, PlanSummary } from './ha-types';
import { layerCounts } from './heat/functions';
import type { HeatLayerId } from './heat/types';
import { LayerToggles } from './layer-toggles';
import type { PlanView } from './plan-view';
import type { TimeBar } from './time-bar';
import { button, h } from './ui';
import { UnderlayStore } from './underlay-store';
import { UpdateNotice } from './version';

export interface ViewerHost {
  /** The panel or card: it gets the `history` attribute, its shadow root the slider's styles. */
  readonly el: HTMLElement;
  /** Put the slider's bar on the page. */
  place(bar: HTMLElement): void;
  /** The user picked a layer or switched the mesh (the panel remembers them). */
  changed?(layer: HeatLayerId | null, mesh: boolean): void;
}

/** Which stored plan to show, for `ViewerController.follow`. */
export interface FollowRule {
  /** The plan to show among the stored ones; undefined for none. */
  pick(plans: readonly PlanSummary[]): PlanSummary | undefined;
  /**
   * When the rule names one plan: changes to other plans cannot change the pick, so they are
   * ignored. Otherwise any change lists the plans again and picks anew.
   */
  planId?: string;
}

/** What following a plan came to, each time it loads (the host shows it). */
export type FollowResult =
  | {
      kind: 'plan';
      planId: string;
      loaded: LoadedPlan;
      /** The first plan shown for the rule, or another than before: the host fits it. */
      moved: boolean;
    }
  | { kind: 'none'; plans: PlanSummary[] }
  | { kind: 'error'; error: unknown };

export class ViewerController {
  readonly layers: LayerToggles;
  readonly timeButton: HTMLButtonElement;
  readonly notice = new UpdateNotice();
  /** The underlay image the view draws: the panel and the editor say which one to show. */
  readonly underlay: UnderlayStore;
  readonly #host: ViewerHost;
  readonly #api: (c: HassConnection) => ChartroomApi;
  #hass?: Hass;
  #layer: HeatLayerId | null = null;
  #time: TimeBar | null = null;
  #load = 0;
  #planId: string | null = null;
  #follow: {
    rule: FollowRule;
    report: (r: FollowResult) => void;
    /** A load has started (it waits for the connection). */
    loaded: boolean;
    /** A plan has been shown for this rule. */
    shown: boolean;
  } | null = null;
  #subscription: Promise<Unsubscribe | null> | null = null;
  /** Saves of ours per plan whose change event has not come back yet. */
  readonly #ownSaves = new Map<string, number>();

  constructor(
    readonly view: PlanView,
    host: ViewerHost,
    api: (c: HassConnection) => ChartroomApi = wsApi,
  ) {
    this.#host = host;
    this.#api = api;
    this.underlay = new UnderlayStore(
      () => this.#hass,
      (url) => view.setUnderlayUrl(url),
    );
    const changed = (): void => host.changed?.(this.#layer, this.view.meshOn);
    this.layers = new LayerToggles(
      (layer) => {
        this.setLayer(layer);
        changed();
      },
      (on) => {
        this.setMesh(on);
        changed();
      },
    );
    this.layers.el.classList.add('layers');
    this.timeButton = button('History', () => void this.toggleTime(), {
      'data-action': 'history',
      'aria-pressed': 'false',
      title: 'Show the plan at an earlier time',
    });
    this.layers.el.append(this.timeButton);
    view.onPlan(() => this.#renderLayers());
    view.setApi(() => this.api);
  }

  get hass(): Hass | undefined {
    return this.#hass;
  }

  set hass(hass: Hass) {
    this.#hass = hass;
    // Only when something the plan reads changed: Home Assistant sends every state change.
    if (this.view.setHass(this.shown())) this.#renderLayers();
    if (!this.#host.el.isConnected) return;
    this.#watchNotice();
    this.#subscribe();
    if (this.#follow && !this.#follow.loaded && hass.connection) void this.#reload();
  }

  /** What the plan shows: live, or the recorded states at the slider's time. */
  shown(): Hass | undefined {
    return this.#time ? this.#time.view(this.#hass) : this.#hass;
  }

  /** The integration's commands, once Home Assistant is connected. */
  get api(): ChartroomApi | null {
    const c = this.#hass?.connection;
    return c ? this.#api(c) : null;
  }

  setLayer(layer: HeatLayerId | null): void {
    this.#layer = layer;
    this.#renderLayers();
  }

  setMesh(on: boolean): void {
    this.layers.setMesh(on);
    if (on !== this.view.meshOn) void this.view.setMesh(on);
  }

  /** Starts a load: the returned check is false once a later one starts. */
  begin(): () => boolean {
    const load = ++this.#load;
    return () => load === this.#load;
  }

  /**
   * Show the plan `rule` picks, now and whenever the stored plans change (saved or deleted here or
   * anywhere else), until `follow` is called again. `report` hears each outcome.
   */
  follow(rule: FollowRule, report: (r: FollowResult) => void): void {
    this.#follow = { rule, report, loaded: false, shown: false };
    if (this.#hass?.connection) void this.#reload();
  }

  /**
   * Save plan `planId`. Its change event, when it comes back, is known as ours: following does not
   * reload a plan for a save made here.
   */
  async save(planId: string, plan: Parameters<ChartroomApi['savePlan']>[1]): Promise<void> {
    const api = this.api;
    if (!api) throw new Error('not connected');
    this.#ownSaves.set(planId, (this.#ownSaves.get(planId) ?? 0) + 1);
    try {
      await api.savePlan(planId, plan);
    } catch (err) {
      this.#ownSave(planId);
      throw err;
    }
  }

  /** Fetch a plan and show it; null when a later load started meanwhile. */
  async load(planId: string, current = this.begin()): Promise<LoadedPlan | null> {
    const api = this.api;
    if (!api) throw new Error('not connected');
    const loaded = await api.getPlan(planId);
    if (!current()) return null;
    this.view.setPlan(loaded.plan);
    if (planId !== this.#planId) void this.#time?.load();
    this.#planId = planId;
    return loaded;
  }

  async toggleTime(): Promise<void> {
    if (this.#time) return this.closeTime();
    const { TimeBar, timeBarStyles } = await import('./time-bar');
    if (this.#time) return;
    const root = this.#host.el.shadowRoot!;
    if (!root.querySelector('style.time'))
      root.append(h('style', { class: 'time' }, timeBarStyles));
    const time = new TimeBar({
      hass: () => this.#hass,
      plan: () => this.view.plan,
      changed: () => this.view.setHass(this.shown()),
      live: () => this.closeTime(),
    });
    this.#time = time;
    this.#host.place(time.el);
    this.#markTime();
    await time.load();
  }

  closeTime(): void {
    if (!this.#time) return;
    this.#time.close();
    this.#time = null;
    this.view.setHass(this.#hass);
    this.#markTime();
  }

  /** Back on the page: check the version again, follow plan changes and rebuild the layers. */
  connect(): void {
    this.#watchNotice();
    this.#subscribe();
    // Given hass before it was on the page (Lovelace may do that): the first load is still due.
    if (this.#follow && !this.#follow.loaded && this.#hass?.connection) void this.#reload();
    void this.view.resume();
  }

  /** Off the page: release the layers, stop playing and stop watching the connection. */
  disconnect(): void {
    this.view.dispose();
    this.#time?.pause();
    this.notice.dispose();
    const unsubscribe = this.#subscription;
    this.#subscription = null;
    void unsubscribe?.then((u) => u?.());
  }

  #watchNotice(): void {
    const c = this.#hass?.connection;
    if (c) this.notice.watch(c, this.#api(c));
  }

  /** Listen for plan changes while following one and on the page. */
  #subscribe(): void {
    const api = this.api;
    if (!this.#follow || this.#subscription || !api) return;
    this.#subscription = api.subscribePlans((e) => this.#changed(e)).catch(() => null);
  }

  /** Whether `e` is the echo of a save made here (and counts it off). */
  #ownSave(planId: string): boolean {
    const n = this.#ownSaves.get(planId) ?? 0;
    if (n === 0) return false;
    if (n === 1) this.#ownSaves.delete(planId);
    else this.#ownSaves.set(planId, n - 1);
    return true;
  }

  #changed(e: PlanEvent): void {
    if (!e.deleted && this.#ownSave(e.plan_id)) return;
    const follow = this.#follow;
    if (!follow) return;
    const named = follow.rule.planId;
    if (named !== undefined && e.plan_id !== named) return;
    void this.#reload();
  }

  /** List the plans, pick one with the rule and load it. */
  async #reload(): Promise<void> {
    const follow = this.#follow;
    const api = this.api;
    if (!follow || !api) return;
    follow.loaded = true;
    const current = this.begin();
    try {
      const plans = await api.listPlans();
      if (!current() || follow !== this.#follow) return;
      const summary = follow.rule.pick(plans);
      if (!summary) {
        this.#planId = null;
        this.view.setPlan(null);
        return follow.report({ kind: 'none', plans });
      }
      const before = this.#planId;
      const loaded = await this.load(summary.id, current);
      if (!loaded || follow !== this.#follow) return;
      const moved = !follow.shown || before !== summary.id;
      follow.shown = true;
      follow.report({ kind: 'plan', planId: summary.id, loaded, moved });
    } catch (error) {
      if (current() && follow === this.#follow) follow.report({ kind: 'error', error });
    }
  }

  #markTime(): void {
    this.timeButton.setAttribute('aria-pressed', String(!!this.#time));
    this.#host.el.toggleAttribute('history', !!this.#time);
  }

  /** The layer buttons follow the plan's sensors; a layer without sensors shows nothing. */
  #renderLayers(): void {
    const counts = layerCounts(this.view.plan, this.shown());
    this.layers.update(this.#layer, counts);
    const show = this.#layer && counts[this.#layer] > 0 ? this.#layer : null;
    if (show !== this.view.layer) void this.view.setLayer(show);
  }
}
