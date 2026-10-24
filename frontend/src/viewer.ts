// What the panel and the card share around the plan view: the layer buttons, the History slider
// (loaded on first use), the hass the plan shows, loading a plan, and releasing the view's layers
// while the element is off the page.
import type { Hass } from './ha-types';
import { layerCounts, type HeatLayerId } from './heat';
import { LayerToggles } from './layer-toggles';
import { normalizePlan, type Plan } from './plan';
import type { PlanView } from './plan-view';
import type { TimeBar } from './time-bar';
import { button, h } from './ui';
import { UpdateNotice } from './version';

export interface ViewerHost {
  /** The panel or card: it gets the `history` attribute, its shadow root the slider's styles. */
  readonly el: HTMLElement;
  /** Put the slider's bar on the page. */
  place(bar: HTMLElement): void;
  /** The user picked a layer or switched the mesh (the panel remembers them). */
  changed?(layer: HeatLayerId | null, mesh: boolean): void;
}

export class ViewerController {
  readonly layers: LayerToggles;
  readonly timeButton: HTMLButtonElement;
  readonly notice = new UpdateNotice();
  readonly #host: ViewerHost;
  #hass?: Hass;
  #layer: HeatLayerId | null = null;
  #time: TimeBar | null = null;
  #load = 0;
  #planId: string | null = null;

  constructor(
    readonly view: PlanView,
    host: ViewerHost,
  ) {
    this.#host = host;
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
    view.onPlan = () => this.#renderLayers();
  }

  get hass(): Hass | undefined {
    return this.#hass;
  }

  set hass(hass: Hass) {
    this.#hass = hass;
    this.view.setHass(this.shown());
    this.#renderLayers();
    if (this.#host.el.isConnected) this.notice.watch(hass.connection);
  }

  /** What the plan shows: live, or the recorded states at the slider's time. */
  shown(): Hass | undefined {
    return this.#time ? this.#time.view(this.#hass) : this.#hass;
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

  /** Fetch a plan and show it; null when a later load started meanwhile. */
  async load(planId: string, current = this.begin()): Promise<Plan | null> {
    const c = this.#hass?.connection;
    if (!c) throw new Error('not connected');
    const raw = await c.sendMessagePromise<unknown>({
      type: 'chartroom/plans/get',
      plan_id: planId,
    });
    const plan = normalizePlan(raw);
    if (!current()) return null;
    this.view.setPlan(plan);
    if (planId !== this.#planId) void this.#time?.load();
    this.#planId = planId;
    return plan;
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

  /** Back on the page: check the version again and rebuild the layers that were on. */
  connect(): void {
    this.notice.watch(this.#hass?.connection);
    void this.view.resume();
  }

  /** Off the page: release the layers, stop playing and stop watching the connection. */
  disconnect(): void {
    this.view.dispose();
    this.#time?.pause();
    this.notice.dispose();
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
