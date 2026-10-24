import { DeviceControls, deviceControlStyles } from './device-controls';
import type { Hass, PlanSummary } from './ha-types';
import { isHeatLayer, layerCounts, type HeatLayerId } from './heat';
import { LayerToggles } from './layer-toggles';
import { normalizePlan } from './plan';
import { PlanView, planViewStyles } from './plan-view';

export interface ChartroomCardConfig {
  type: string;
  title?: string;
  /** The plan to show (its storage id). */
  plan_id?: string;
  /** Or: the plan of this Home Assistant floor. Without either, the first plan. */
  floor_id?: string;
  /** CSS height of the plan, e.g. 320px. In the sections view the grid sets it. */
  height?: string;
  /** Heatmap layer to show: temperature or humidity. Default: none. */
  layer?: HeatLayerId | 'none';
  /** Show the Temperature / Humidity buttons on the card. */
  layer_toggles?: boolean;
}

/** The Chartroom dashboard card: one floor's plan with live device markers. */
export class ChartroomCard extends HTMLElement {
  #config?: ChartroomCardConfig;
  #hass?: Hass;
  #view = new PlanView(true);
  #controls = new DeviceControls(this.#view, this, () => this.#hass);
  #title: HTMLElement;
  #stage: HTMLElement;
  #message: HTMLElement;
  #loaded = '';
  #load = 0;
  #layers = new LayerToggles((layer) => {
    this.#layer = layer;
    this.#renderLayers();
  });
  #layer: HeatLayerId | null = null;
  #unsubscribe: Promise<(() => Promise<void> | void) | null> | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${planViewStyles}${deviceControlStyles}
      :host { display: block; color: var(--primary-text-color, #212121); height: 100%; }
      ha-card, .card { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
      .title { margin: 0; padding: 12px 16px 0; font-size: 1.25rem; font-weight: 400; }
      .title:empty { display: none; }
      .stage { position: relative; flex: 1 1 auto; min-height: 120px; height: var(--chartroom-height, 320px); padding: 8px; box-sizing: border-box; }
      .message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        padding: 16px; text-align: center; color: var(--secondary-text-color, #727272); }
      .layers { position: absolute; left: 12px; top: 12px; z-index: 1; }
      .layers button { font: inherit; font-size: 12px; color: inherit; padding: 2px 8px; border-radius: 6px; cursor: pointer;
        border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); }
      .layers button[aria-pressed=true] { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); border-color: transparent; }
      .layers button:disabled { opacity: 0.4; cursor: default; }
      [hidden] { display: none !important; }`;
    // ha-card is Home Assistant's own element; outside HA it is just an unknown element.
    const card = document.createElement('ha-card');
    card.className = 'card';
    this.#title = document.createElement('h2');
    this.#title.className = 'title';
    this.#message = document.createElement('div');
    this.#message.className = 'message';
    this.#message.textContent = 'Loading…';
    this.#stage = document.createElement('div');
    this.#stage.className = 'stage';
    this.#layers.el.classList.add('layers');
    this.#layers.el.hidden = true;
    this.#view.onPlan = () => this.#renderLayers();
    this.#stage.append(this.#view.el, this.#layers.el, this.#message, this.#controls.dialog);
    card.append(this.#title, this.#stage);
    root.append(style, card);
    this.#controls.attach();
  }

  setConfig(config: ChartroomCardConfig): void {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    this.#config = config;
    this.#title.textContent = config.title ?? '';
    if (config.height) this.style.setProperty('--chartroom-height', config.height);
    else this.style.removeProperty('--chartroom-height');
    if (config.layer !== undefined && config.layer !== 'none' && !isHeatLayer(config.layer))
      throw new Error('layer must be temperature, humidity or none');
    this.#layer = isHeatLayer(config.layer) ? config.layer : null;
    this.#layers.el.hidden = config.layer_toggles !== true;
    this.#renderLayers();
    this.#loaded = '';
    if (this.#hass) void this.#loadPlan();
  }

  set hass(hass: Hass) {
    this.#hass = hass;
    this.#view.setHass(hass);
    this.#renderLayers();
    if (!this.#loaded && hass.connection) void this.#loadPlan();
    if (this.isConnected) this.#subscribe();
  }

  connectedCallback(): void {
    if (this.#hass) this.#subscribe();
  }

  disconnectedCallback(): void {
    const unsub = this.#unsubscribe;
    this.#unsubscribe = null;
    void unsub?.then((u) => u?.());
  }

  /** Reload when a plan is saved or deleted elsewhere (the editor in the panel), so edits show live. */
  #subscribe(): void {
    const c = this.#hass?.connection;
    if (this.#unsubscribe || !c?.subscribeMessage) return;
    this.#unsubscribe = c
      .subscribeMessage<{ plan_id: string; deleted: boolean }>(
        (e) => {
          const shown = this.dataset['plan'];
          if (!shown || e.plan_id === shown || !this.#config?.plan_id) {
            this.#loaded = '';
            void this.#loadPlan(true);
          }
        },
        { type: 'chartroom/plans/subscribe' },
      )
      .catch(() => null);
  }

  async #loadPlan(live = false): Promise<void> {
    const c = this.#hass?.connection;
    if (!c || !this.#config) return;
    const want = `${this.#config.plan_id ?? ''}|${this.#config.floor_id ?? ''}`;
    this.#loaded = want;
    const load = ++this.#load;
    try {
      const { plans } = await c.sendMessagePromise<{ plans: PlanSummary[] }>({
        type: 'chartroom/plans/list',
      });
      const cfg = this.#config;
      const summary = cfg.plan_id
        ? plans.find((p) => p.id === cfg.plan_id)
        : cfg.floor_id
          ? plans.find((p) => p.floor_id === cfg.floor_id)
          : plans[0];
      if (!summary) {
        delete this.dataset['plan'];
        this.#view.setPlan(null);
        this.#show(
          plans.length === 0
            ? 'No floor plan yet. Draw one in the Chartroom panel.'
            : `No plan ${cfg.plan_id ? `"${cfg.plan_id}"` : `for floor "${cfg.floor_id}"`}.`,
        );
        return;
      }
      const raw = await c.sendMessagePromise<unknown>({
        type: 'chartroom/plans/get',
        plan_id: summary.id,
      });
      if (load !== this.#load) return;
      this.#view.setPlan(normalizePlan(raw));
      if (!live || this.dataset['plan'] !== summary.id) this.#view.fit();
      this.dataset['plan'] = summary.id;
      this.#show(null);
    } catch (err) {
      if (load === this.#load)
        this.#show(`Could not load the plan: ${(err as Error).message ?? err}`);
    }
  }

  #show(message: string | null): void {
    this.#message.hidden = message === null;
    this.#message.textContent = message ?? '';
    this.#view.el.classList.toggle('hidden', message !== null);
  }

  #renderLayers(): void {
    const counts = layerCounts(this.#view.plan, this.#hass);
    this.#layers.update(this.#layer, counts);
    const show = this.#layer && counts[this.#layer] > 0 ? this.#layer : null;
    if (show !== this.#view.layer) void this.#view.setLayer(show);
  }

  /** The view, for tests. */
  get view(): PlanView {
    return this.#view;
  }

  getCardSize(): number {
    return 6;
  }

  getGridOptions(): { columns: number; rows: number; min_columns: number; min_rows: number } {
    return { columns: 12, rows: 6, min_columns: 6, min_rows: 3 };
  }

  static getStubConfig(): ChartroomCardConfig {
    return { type: 'custom:chartroom-card' };
  }

  get config(): ChartroomCardConfig | undefined {
    return this.#config;
  }
}

declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string; documentationURL?: string }[];
  }
}

if (!customElements.get('chartroom-card')) {
  customElements.define('chartroom-card', ChartroomCard);
  window.customCards ??= [];
  window.customCards.push({
    type: 'chartroom-card',
    name: 'Chartroom',
    description: 'A floor plan with live device markers: tap to toggle, hold for details.',
    documentationURL: 'https://github.com/captains-chest/chartroom',
  });
}
