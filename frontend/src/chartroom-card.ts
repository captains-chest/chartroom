import type { Hass } from './ha-types';
import { floorsKey, groupAreasByFloor } from './model';
import { baseStyles, floorList, placeholderPlan } from './render';

export interface ChartroomCardConfig {
  type: string;
  title?: string;
}

/** The Chartroom dashboard card. Phase 0: an empty plan and the floors. */
export class ChartroomCard extends HTMLElement {
  #config?: ChartroomCardConfig;
  #key = '';
  #title: HTMLElement;
  #floors: HTMLElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${baseStyles}
      ha-card, .card { display: block; padding: 16px; }
      .title { margin: 0 0 8px; font-size: 1.25rem; font-weight: 400; }`;
    // ha-card is Home Assistant's own element; outside HA it is just an unknown element.
    const card = document.createElement('ha-card');
    card.className = 'card';
    this.#title = document.createElement('h2');
    this.#title.className = 'title';
    this.#floors = document.createElement('div');
    card.append(this.#title, placeholderPlan('No floor plan yet'), this.#floors);
    root.append(style, card);
  }

  setConfig(config: ChartroomCardConfig): void {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    this.#config = config;
    this.#title.textContent = config.title ?? 'Chartroom';
  }

  set hass(hass: Hass) {
    const groups = groupAreasByFloor(hass);
    const key = floorsKey(groups);
    if (key === this.#key) return;
    this.#key = key;
    this.#floors.replaceChildren(floorList(groups));
  }

  getCardSize(): number {
    return 4;
  }

  getGridOptions(): { columns: number; rows: number; min_columns: number } {
    return { columns: 12, rows: 4, min_columns: 6 };
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
    description: 'Your floor plan with live layers.',
    documentationURL: 'https://github.com/captains-chest/chartroom',
  });
}
