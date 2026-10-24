import type { Hass } from './ha-types';
import { floorsKey, groupAreasByFloor } from './model';
import { baseStyles, floorList, placeholderPlan } from './render';
import { pingWorker } from './field-worker';

interface PanelInfo {
  config?: { version?: string };
}

interface PlanSummary {
  id: string;
  name: string;
}

/** The full-screen Chartroom panel. Phase 0: an empty plan, the house's floors and areas. */
export class ChartroomPanel extends HTMLElement {
  #hass?: Hass;
  #key = '';
  #floors: HTMLElement;
  #status: HTMLElement;
  #plansRequested = false;
  narrow = false;
  panel?: PanelInfo;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${baseStyles}
      :host { min-height: 100vh; padding: 16px; box-sizing: border-box; background: var(--primary-background-color, #fafafa); }
      header h1 { margin: 0 0 12px; font-size: 1.5rem; font-weight: 400; }
      main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(200px, 1fr); gap: 16px; }
      :host([narrow]) main { grid-template-columns: 1fr; }
      .status { color: var(--secondary-text-color, #727272); font-size: 0.85rem; }`;
    const header = document.createElement('header');
    const h1 = document.createElement('h1');
    h1.textContent = 'Chartroom';
    this.#status = document.createElement('p');
    this.#status.className = 'status';
    header.append(h1, this.#status);
    const main = document.createElement('main');
    this.#floors = document.createElement('aside');
    main.append(placeholderPlan('No floor plan yet'), this.#floors);
    root.append(style, header, main);
  }

  connectedCallback(): void {
    pingWorker().then(
      (v) => this.#setStatus('worker', `worker ${v} ready`),
      () => this.#setStatus('worker', 'worker unavailable'),
    );
  }

  set hass(hass: Hass) {
    this.#hass = hass;
    this.toggleAttribute('narrow', this.narrow);
    const groups = groupAreasByFloor(hass);
    const key = floorsKey(groups);
    if (key !== this.#key) {
      this.#key = key;
      this.#floors.replaceChildren(floorList(groups));
    }
    if (!this.#plansRequested && hass.connection) {
      this.#plansRequested = true;
      hass.connection
        .sendMessagePromise<{ plans: PlanSummary[] }>({ type: 'chartroom/plans/list' })
        .then(
          (r) => this.#setStatus('plans', `${r.plans.length} saved plan(s)`),
          () => this.#setStatus('plans', 'plans unavailable'),
        );
    }
  }

  get hass(): Hass | undefined {
    return this.#hass;
  }

  #parts = new Map<string, string>();
  #setStatus(part: string, text: string): void {
    this.#parts.set(part, text);
    this.#status.textContent = [...this.#parts.values()].join(' · ');
    this.#status.dataset[part] = text;
  }
}

if (!customElements.get('chartroom-panel'))
  customElements.define('chartroom-panel', ChartroomPanel);
