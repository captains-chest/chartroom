import type { Unsubscribe } from './api';
import { DeviceControls, deviceControlStyles } from './device-controls';
import type { Hass } from './ha-types';
import { isHeatLayer, type HeatLayerId } from './heat';
import { PlanView, planViewStyles } from './plan-view';
import { updateNoticeStyles } from './version';
import { ViewerController } from './viewer';

export interface ChartroomCardConfig {
  type: string;
  title?: string;
  /** The plan to show (its storage id). */
  plan_id?: string;
  /** Or: the plan of this Home Assistant floor. Without either, the first plan. */
  floor_id?: string;
  /** CSS height of the plan, e.g. 320px. In the sections view the grid sets it. */
  height?: string;
  /** Heatmap layer to show: temperature, humidity or signal. Default: none. */
  layer?: HeatLayerId | 'none';
  /** Show the mesh links between placed Zigbee and Z-Wave devices. */
  mesh?: boolean;
  /** Show the layer buttons (Temperature, Humidity, Signal, Mesh) on the card. */
  layer_toggles?: boolean;
  /** Show a History button that opens the time slider (loaded on first use). */
  history?: boolean;
}

/** The Chartroom dashboard card: one floor's plan with live device markers. */
export class ChartroomCard extends HTMLElement {
  #config?: ChartroomCardConfig;
  #view = new PlanView(true);
  #viewer = new ViewerController(this.#view, {
    el: this,
    place: (bar) => this.#stage.after(bar),
  });
  #controls = new DeviceControls(this.#view, this, () => this.#viewer.shown());
  #title: HTMLElement;
  #stage: HTMLElement;
  #message: HTMLElement;
  #loaded = '';
  #unsubscribe: Promise<Unsubscribe | null> | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${planViewStyles}${deviceControlStyles}${updateNoticeStyles}
      :host { display: block; color: var(--primary-text-color, #212121); height: 100%; }
      ha-card, .card { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden; }
      .title { margin: 0; padding: 12px 16px 0; font-size: 1.25rem; font-weight: 400; }
      .title:empty { display: none; }
      .stage { position: relative; flex: 1 1 auto; min-height: 120px; height: var(--chartroom-height, 320px); padding: 8px; box-sizing: border-box; }
      .message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        padding: 16px; text-align: center; color: var(--secondary-text-color, #727272); }
      .layers { position: absolute; left: 12px; right: 12px; top: 12px; z-index: 1; flex-wrap: wrap; pointer-events: none; }
      .layers > * { pointer-events: auto; }
      .layers button { font: inherit; font-size: 12px; color: inherit; padding: 2px 8px; border-radius: 6px; cursor: pointer;
        border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); }
      .layers button[aria-pressed=true] { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); border-color: transparent; }
      .layers button:disabled { opacity: 0.4; cursor: default; }
      .layers.no-toggles > [data-layer] { display: none; }
      :host([history]) .stage { box-shadow: inset 0 0 0 3px var(--warning-color, #ff9800); }
      .card > .timebar { position: static; transform: none; width: auto; margin: 0 8px 8px; flex-wrap: wrap; box-shadow: none; }
      .card > .timebar input { flex-basis: 100%; order: 1; }
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
    this.#viewer.layers.el.hidden = true;
    this.#stage.append(
      this.#view.el,
      this.#viewer.layers.el,
      this.#viewer.notice.el,
      this.#message,
      this.#controls.dialog,
    );
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
      throw new Error('layer must be temperature, humidity, signal or none');
    const viewer = this.#viewer;
    if (config.history !== true) viewer.closeTime();
    viewer.setLayer(isHeatLayer(config.layer) ? config.layer : null);
    viewer.setMesh(config.mesh === true);
    viewer.layers.el.hidden = config.layer_toggles !== true && config.history !== true;
    viewer.layers.el.classList.toggle('no-toggles', config.layer_toggles !== true);
    viewer.timeButton.hidden = config.history !== true;
    this.#loaded = '';
    if (viewer.hass) void this.#loadPlan();
  }

  set hass(hass: Hass) {
    this.#viewer.hass = hass;
    if (!this.#loaded && hass.connection) void this.#loadPlan();
    if (this.isConnected) this.#subscribe();
  }

  // Lovelace moves cards by removing and re-adding them: release on removal, rebuild on return.
  connectedCallback(): void {
    if (this.#viewer.hass) this.#subscribe();
    this.#viewer.connect();
  }

  disconnectedCallback(): void {
    const unsub = this.#unsubscribe;
    this.#unsubscribe = null;
    void unsub?.then((u) => u?.());
    this.#viewer.disconnect();
  }

  /** Reload when a plan is saved or deleted elsewhere (the editor in the panel), so edits show live. */
  #subscribe(): void {
    const api = this.#viewer.api;
    if (this.#unsubscribe || !api) return;
    this.#unsubscribe = api
      .subscribePlans((e) => {
        const shown = this.dataset['plan'];
        if (!shown || e.plan_id === shown || !this.#config?.plan_id) {
          this.#loaded = '';
          void this.#loadPlan(true);
        }
      })
      .catch(() => null);
  }

  async #loadPlan(live = false): Promise<void> {
    const api = this.#viewer.api;
    if (!api || !this.#config) return;
    this.#loaded = `${this.#config.plan_id ?? ''}|${this.#config.floor_id ?? ''}`;
    const current = this.#viewer.begin();
    try {
      const plans = await api.listPlans();
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
      if (!(await this.#viewer.load(summary.id, current))) return;
      if (!live || this.dataset['plan'] !== summary.id) this.#view.fit();
      this.dataset['plan'] = summary.id;
      this.#show(null);
    } catch (err) {
      if (current()) this.#show(`Could not load the plan: ${(err as Error).message ?? err}`);
    }
  }

  #show(message: string | null): void {
    this.#message.hidden = message === null;
    this.#message.textContent = message ?? '';
    this.#view.el.classList.toggle('hidden', message !== null);
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
