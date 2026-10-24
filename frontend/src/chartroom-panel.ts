import type { Hass, PlanSummary } from './ha-types';
import { pingWorker } from './field-worker';
import { emptyPlan, type Plan } from './plan';
import { type FloorTab, floorTabs, planIdForFloor } from './model';
import type { PlanEditor } from './plan-editor';
import { updateNoticeStyles } from './version';
import { DeviceControls, deviceControlStyles } from './device-controls';
import { PlanView, planViewStyles } from './plan-view';
import { isHeatLayer } from './heat';
import { button, h } from './ui';
import { loadUnderlayUrl } from './underlay';
import { ViewerController } from './viewer';

interface PanelInfo {
  config?: { version?: string };
}

const TAB_KEY = 'chartroom:tab';
const UNDERLAY_KEY = 'chartroom:underlay';
const LAYER_KEY = 'chartroom:layer';
const MESH_KEY = 'chartroom:mesh';

interface UnderlayPref {
  visible: boolean;
  /** null: the opacity saved in the plan. */
  opacity: number | null;
}

function readUnderlayPref(): UnderlayPref {
  try {
    const v = JSON.parse(localStorage.getItem(UNDERLAY_KEY) ?? 'null') as Partial<UnderlayPref>;
    return {
      visible: v?.visible !== false,
      opacity: typeof v?.opacity === 'number' ? Math.min(1, Math.max(0.05, v.opacity)) : null,
    };
  } catch {
    return { visible: true, opacity: null };
  }
}

/** The full-screen Chartroom panel: the plan of each floor, with pan, zoom and the editor. */
export class ChartroomPanel extends HTMLElement {
  #view = new PlanView();
  #viewer = new ViewerController(this.#view, {
    el: this,
    place: (bar) => this.#sheet.append(bar),
    changed: (layer, mesh) => {
      if (layer) localStorage.setItem(LAYER_KEY, layer);
      else localStorage.removeItem(LAYER_KEY);
      if (mesh) localStorage.setItem(MESH_KEY, '1');
      else localStorage.removeItem(MESH_KEY);
    },
  });
  #controls = new DeviceControls(this.#view, this, () => this.#viewer.shown());
  #tabsEl: HTMLElement;
  #status: HTMLElement;
  #stage: HTMLElement;
  #empty: HTMLElement;
  #editButton: HTMLButtonElement;
  #menuButton: HTMLButtonElement;
  #toolbarSlot: HTMLElement;
  #inspectorSlot: HTMLElement;
  #plans: PlanSummary[] | null = null;
  #tabs: FloorTab[] = [];
  #tabsKey = '';
  #tab: string | null = null;
  #planId: string | null = null;
  #plan: Plan | null = null;
  #editor: PlanEditor | null = null;
  #underlayLoad = 0;
  #underlayPref = readUnderlayPref();
  #underlayControls: HTMLElement;
  #underlayToggle: HTMLButtonElement;
  #underlayOpacity: HTMLInputElement;
  #plansRequested = false;
  #sheet: HTMLElement;
  #narrow = false;
  panel?: PanelInfo;

  /** Home Assistant sets this when its sidebar is hidden (phones, the companion app). */
  set narrow(v: boolean) {
    this.#narrow = v;
    this.toggleAttribute('narrow', v);
    this.#menuButton.hidden = !v;
  }

  get narrow(): boolean {
    return this.#narrow;
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = h('style');
    style.textContent = panelStyles + planViewStyles + deviceControlStyles + updateNoticeStyles;
    this.#controls.attach();
    this.#menuButton = button('☰', () => this.#toggleMenu(), {
      class: 'menu',
      'aria-label': 'Sidebar',
      hidden: !this.#narrow,
    });
    this.#tabsEl = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Floors' });
    this.#editButton = button('Edit', () => void this.#toggleEditor(), {
      class: 'edit',
      hidden: true,
    });
    this.#status = h('p', { class: 'status' });
    this.#toolbarSlot = h('div', { class: 'toolbar-slot' });
    this.#inspectorSlot = h('aside', { class: 'inspector-slot', hidden: true });
    this.#empty = h('div', { class: 'empty', hidden: true });
    const zoom = h(
      'div',
      { class: 'zoom' },
      button('+', () => this.#view.zoom(1.4), { 'aria-label': 'Zoom in', title: 'Zoom in' }),
      button('−', () => this.#view.zoom(1 / 1.4), { 'aria-label': 'Zoom out', title: 'Zoom out' }),
      button('⤢', () => this.#view.fit(), { 'aria-label': 'Fit plan', title: 'Fit plan' }),
    );
    this.#underlayToggle = button(
      'Underlay',
      () => this.#setUnderlayPref({ visible: !this.#underlayPref.visible }),
      {
        title: 'Show or hide the drawing under the plan',
        'data-action': 'toggle-underlay',
      },
    );
    this.#underlayOpacity = h('input', {
      type: 'range',
      min: 0.05,
      max: 1,
      step: 0.05,
      'aria-label': 'Underlay opacity',
      name: 'underlay-opacity',
    });
    this.#underlayOpacity.addEventListener('input', () =>
      this.#setUnderlayPref({ opacity: this.#underlayOpacity.valueAsNumber }),
    );
    this.#underlayControls = h(
      'div',
      { class: 'underlay-controls', hidden: true },
      this.#underlayToggle,
      this.#underlayOpacity,
    );
    const stored = localStorage.getItem(LAYER_KEY);
    this.#viewer.setLayer(isHeatLayer(stored) ? stored : null);
    if (localStorage.getItem(MESH_KEY) === '1') this.#viewer.setMesh(true);
    // On a desktop the sheet's parts float over the plan; on a phone they dock below it.
    this.#sheet = h(
      'div',
      { class: 'sheet' },
      button('', () => this.#sheet.classList.toggle('open'), {
        class: 'grip',
        'aria-label': 'More controls',
      }),
      this.#viewer.layers.el,
      this.#underlayControls,
    );
    this.#stage = h(
      'div',
      { class: 'stage' },
      this.#view.el,
      this.#empty,
      zoom,
      this.#sheet,
      this.#viewer.notice.el,
      this.#controls.dialog,
    );
    root.append(
      style,
      h(
        'header',
        {},
        this.#menuButton,
        h('h1', {}, 'Chartroom'),
        this.#tabsEl,
        h('span', { class: 'spacer' }),
        this.#editButton,
      ),
      this.#toolbarSlot,
      h('main', {}, this.#stage, this.#inspectorSlot),
      h('footer', {}, this.#status),
    );
  }

  connectedCallback(): void {
    pingWorker().then(
      (v) => this.#setStatus('worker', `worker ${v} ready`),
      () => this.#setStatus('worker', 'worker unavailable'),
    );
    window.addEventListener('keydown', this.#onKey);
    this.#viewer.connect();
  }

  // Home Assistant may detach the panel and attach it again: release the layers meanwhile.
  disconnectedCallback(): void {
    window.removeEventListener('keydown', this.#onKey);
    this.#viewer.disconnect();
  }

  set hass(hass: Hass) {
    this.#viewer.hass = hass;
    if (!this.#plansRequested && hass.connection) {
      this.#plansRequested = true;
      void this.#refreshPlans();
    }
    if (this.#plans) this.#renderTabs();
    this.#editor?.hassChanged();
  }

  get hass(): Hass | undefined {
    return this.#viewer.hass;
  }

  /** The plan on screen (for tests and the editor). */
  get plan(): Plan | null {
    return this.#editor?.plan ?? this.#plan;
  }

  /** The view, for tests. */
  get view(): PlanView {
    return this.#view;
  }

  get isAdmin(): boolean {
    return this.#viewer.hass?.user?.is_admin ?? true;
  }

  #ws<T>(message: { type: string; [key: string]: unknown }): Promise<T> {
    const c = this.#viewer.hass?.connection;
    if (!c) return Promise.reject(new Error('not connected'));
    return c.sendMessagePromise<T>(message);
  }

  async #refreshPlans(): Promise<void> {
    try {
      const r = await this.#ws<{ plans: PlanSummary[] }>({ type: 'chartroom/plans/list' });
      this.#plans = r.plans;
      this.#setStatus('plans', `${r.plans.length} saved plan(s)`);
    } catch {
      this.#plans = [];
      this.#setStatus('plans', 'plans unavailable');
    }
    this.#tabsKey = '';
    this.#renderTabs();
  }

  #renderTabs(): void {
    const tabs = floorTabs(this.#viewer.hass, this.#plans ?? []);
    const key = JSON.stringify(tabs);
    if (key === this.#tabsKey) return;
    this.#tabsKey = key;
    this.#tabs = tabs;
    this.#tabsEl.replaceChildren(
      ...tabs.map((t) => {
        const b = button(t.label, () => void this.#selectTab(t.key), {
          role: 'tab',
          'data-tab': t.key,
          'data-plan': t.plan_id ?? '',
        });
        if (!t.plan_id) b.classList.add('no-plan');
        return b;
      }),
    );
    // Keep the current tab (or the one holding the current plan), else the remembered one, else
    // the first with a plan.
    const holding = this.#planId ? tabs.find((t) => t.plan_id === this.#planId) : undefined;
    const remembered = localStorage.getItem(TAB_KEY);
    const pick =
      holding ??
      tabs.find((t) => t.key === this.#tab) ??
      tabs.find((t) => t.key === remembered) ??
      tabs.find((t) => t.plan_id) ??
      tabs[0];
    if (pick && (pick.key !== this.#tab || pick.plan_id !== this.#planId))
      void this.#selectTab(pick.key);
    else this.#markTab();
    if (tabs.length === 0) this.#showEmpty('No floors in Home Assistant yet, and no saved plans.');
  }

  #markTab(): void {
    for (const b of this.#tabsEl.querySelectorAll<HTMLElement>('[role=tab]')) {
      b.setAttribute('aria-selected', String(b.dataset['tab'] === this.#tab));
    }
  }

  async #selectTab(key: string): Promise<void> {
    const tab = this.#tabs.find((t) => t.key === key);
    if (!tab) return;
    if (this.#editor) await this.#closeEditor();
    this.#tab = key;
    localStorage.setItem(TAB_KEY, key);
    this.#markTab();
    if (!tab.plan_id) {
      this.#viewer.closeTime();
      this.#planId = null;
      this.#plan = null;
      this.#view.setPlan(null);
      void this.#loadUnderlay();
      this.#editButton.hidden = true;
      this.#showEmpty(`No plan for ${tab.label} yet.`, tab);
      return;
    }
    if (tab.plan_id === this.#planId && this.#plan) return;
    try {
      const plan = await this.#viewer.load(tab.plan_id);
      if (!plan) return;
      this.#planId = tab.plan_id;
      this.#plan = plan;
      this.#showEmpty(null);
      this.#view.fit();
      void this.#loadUnderlay();
      this.#editButton.hidden = !this.isAdmin;
      this.dataset['plan'] = tab.plan_id;
    } catch (err) {
      this.#showEmpty(`Could not load this plan: ${(err as Error).message ?? err}`);
    }
  }

  /** Fetch the current plan's underlay (if any) and show it in the read-only view. */
  async #loadUnderlay(): Promise<void> {
    const load = ++this.#underlayLoad;
    const u = this.#plan?.underlay;
    this.#view.setUnderlayUrl(null);
    this.#renderUnderlayControls();
    if (!u) return;
    try {
      const url = await loadUnderlayUrl(this.#viewer.hass, u.url);
      if (load !== this.#underlayLoad) {
        URL.revokeObjectURL(url);
        return;
      }
      this.#view.setUnderlayUrl(url);
    } catch {
      // The plan still shows without its drawing.
    }
  }

  #setUnderlayPref(patch: Partial<UnderlayPref>): void {
    this.#underlayPref = { ...this.#underlayPref, ...patch };
    localStorage.setItem(UNDERLAY_KEY, JSON.stringify(this.#underlayPref));
    this.#renderUnderlayControls();
  }

  /** The viewer's show/hide and opacity choice; the editor always shows the plan's own. */
  #renderUnderlayControls(): void {
    const u = this.#plan?.underlay;
    const editing = this.#editor !== null;
    const pref = this.#underlayPref;
    this.#underlayControls.hidden = !u || editing;
    this.#underlayToggle.setAttribute('aria-pressed', String(pref.visible));
    this.#underlayOpacity.hidden = !pref.visible;
    this.#underlayOpacity.value = String(pref.opacity ?? u?.opacity ?? 0.5);
    this.#view.setUnderlayDisplay(editing ? null : pref);
  }

  #showEmpty(text: string | null, tab?: FloorTab): void {
    this.#empty.hidden = text === null;
    this.#view.el.classList.toggle('hidden', text !== null);
    this.#viewer.layers.el.hidden = text !== null;
    if (text === null) return;
    const children: (HTMLElement | string)[] = [h('p', {}, text)];
    if (tab?.floor_id && this.isAdmin) {
      children.push(
        button('Create plan', () => void this.#createPlan(tab), { class: 'create primary' }),
        h('p', { class: 'hint' }, 'Draw the walls yourself, or import a drawing to trace over.'),
      );
    }
    this.#empty.replaceChildren(...children);
  }

  async #createPlan(tab: FloorTab): Promise<void> {
    if (!tab.floor_id) return;
    const id = planIdForFloor(tab.floor_id);
    await this.#ws({
      type: 'chartroom/plans/save',
      plan_id: id,
      plan: emptyPlan(tab.label, tab.floor_id),
    });
    this.#planId = null;
    await this.#refreshPlans();
    await this.#selectTab(tab.key);
    await this.#toggleEditor();
  }

  async #savePlan(plan: Plan): Promise<void> {
    if (!this.#planId) throw new Error('no plan');
    const { id: _id, ...body } = plan as Plan & { id?: string };
    await this.#ws({ type: 'chartroom/plans/save', plan_id: this.#planId, plan: body });
    const before = this.#plan;
    this.#plan = plan;
    if (
      before &&
      (before.name !== plan.name || (before.floor_id ?? null) !== (plan.floor_id ?? null))
    ) {
      await this.#refreshPlans();
    }
  }

  async #toggleEditor(): Promise<void> {
    if (this.#editor) {
      await this.#closeEditor();
      return;
    }
    if (!this.#plan || !this.#planId) return;
    this.#viewer.closeTime();
    const { PlanEditor } = await import('./plan-editor');
    this.#editor = new PlanEditor({
      view: this.#view,
      hass: () => this.#viewer.hass,
      save: (plan) => this.#savePlan(plan),
      planId: this.#planId,
      plan: this.#plan,
    });
    this.#toolbarSlot.replaceChildren(this.#editor.toolbar);
    this.#inspectorSlot.replaceChildren(this.#editor.inspector);
    this.#inspectorSlot.hidden = false;
    this.#editButton.textContent = 'Done';
    this.toggleAttribute('editing', true);
    this.#renderUnderlayControls();
  }

  async #closeEditor(): Promise<void> {
    const editor = this.#editor;
    if (!editor) return;
    this.#editor = null;
    await editor.close();
    this.#plan = editor.plan;
    this.#toolbarSlot.replaceChildren();
    this.#inspectorSlot.replaceChildren();
    this.#inspectorSlot.hidden = true;
    this.#editButton.textContent = 'Edit';
    this.toggleAttribute('editing', false);
    this.#view.setPlan(this.#plan);
    this.#controls.attach();
    this.#renderUnderlayControls();
  }

  #onKey = (e: KeyboardEvent): void => {
    this.#editor?.key(e);
  };

  #toggleMenu(): void {
    this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true }));
  }

  #parts = new Map<string, string>();
  #setStatus(part: string, text: string): void {
    this.#parts.set(part, text);
    this.#status.textContent = [...this.#parts.values()].join(' · ');
    this.#status.dataset[part] = text;
  }
}

const panelStyles = `
  :host { display: flex; flex-direction: column; height: 100vh; height: 100dvh; box-sizing: border-box;
    color: var(--primary-text-color, #212121); background: var(--primary-background-color, #fafafa);
    font-family: var(--ha-font-family-body, system-ui, sans-serif); }
  [hidden] { display: none !important; }
  button { font: inherit; color: inherit; background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #ccc); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
  button:hover { border-color: var(--primary-color, #03a9f4); }
  button.primary, button[aria-pressed=true], button[aria-selected=true] {
    background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); border-color: transparent; }
  button:disabled { opacity: 0.4; cursor: default; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; min-height: 48px; box-sizing: border-box;
    background: var(--app-header-background-color, var(--primary-color, #03a9f4));
    color: var(--app-header-text-color, var(--text-primary-color, #fff)); }
  header h1 { margin: 0; font-size: 1.25rem; font-weight: 400; }
  header button { background: transparent; color: inherit; border-color: rgba(255,255,255,0.4); }
  header button[aria-selected=true] { background: rgba(255,255,255,0.25); color: inherit; }
  .tabs { display: flex; gap: 4px; overflow-x: auto; }
  .tabs .no-plan { opacity: 0.75; font-style: italic; }
  .spacer { flex: 1; }
  main { flex: 1; display: flex; min-height: 0; }
  .stage { position: relative; flex: 1; min-width: 0; min-height: 0; }
  .layers { position: absolute; left: 12px; top: 12px; padding: 4px; border-radius: 8px;
    background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent); }
  .zoom { position: absolute; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 4px; }
  .zoom button { width: 36px; height: 36px; padding: 0; font-size: 1.1rem; }
  .underlay-controls { position: absolute; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px;
    padding: 4px 8px; border-radius: 6px; background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent); }
  .underlay-controls input { width: 120px; }
  .empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 8px; color: var(--secondary-text-color, #727272); text-align: center; padding: 16px; }
  .empty .hint { font-size: 0.85rem; margin: 0; }
  .inspector-slot { width: 300px; overflow-y: auto; border-left: 1px solid var(--divider-color, #ddd);
    background: var(--card-background-color, #fff); }
  :host([narrow]) main { flex-direction: column; }
  :host([narrow]) .inspector-slot { width: auto; max-height: 40vh; border-left: 0; border-top: 1px solid var(--divider-color, #ddd); }
  :host([history]) .stage { box-shadow: inset 0 0 0 3px var(--warning-color, #ff9800); }
  .sheet { display: contents; }
  .grip { display: none; }
  footer { padding: 2px 16px; }
  .status { margin: 0; color: var(--secondary-text-color, #727272); font-size: 0.8rem; }
  @media (max-width: 600px) {
    header { gap: 8px; padding: 4px 8px; }
    header h1, footer { display: none; }
    .stage { display: flex; flex-direction: column; }
    .stage > .plan-box { flex: 1; min-height: 0; height: auto; }
    .sheet { display: flex; flex-direction: column; gap: 6px; padding: 0 8px calc(8px + env(safe-area-inset-bottom));
      background: var(--card-background-color, #fff); border-radius: 12px 12px 0 0; box-shadow: 0 -1px 6px rgba(0,0,0,0.15); }
    .stage .sheet > * { position: static; transform: none; width: auto; padding: 0; box-shadow: none; background: none; }
    .sheet > .grip { display: block; align-self: center; width: 48px; height: 20px; border: 0; }
    .grip::before { content: ''; display: block; height: 4px; border-radius: 2px; background: var(--divider-color, #ccc); }
    .sheet:not(.open) > .underlay-controls { display: none; }
    .layers { display: flex; gap: 4px; overflow-x: auto; }
    .sheet button { min-height: 36px; }
    .sheet > .timebar { flex-wrap: wrap; }
    .sheet > .timebar input { order: 9; flex-basis: 100%; }
    .zoom { top: 8px; bottom: auto; right: 8px; }
    .zoom button:not(:last-child) { display: none; }
    .heat-legend { top: 8px; left: 8px; right: auto; width: 150px; font-size: 11px; }
  }
`;

if (!customElements.get('chartroom-panel'))
  customElements.define('chartroom-panel', ChartroomPanel);
