import type { ChartroomApi } from './api';
import type { Hass, PlanSummary } from './ha-types';
import { holdWorker } from './field-worker';
import { emptyPlan } from './plan/functions';
import type { Plan } from './plan/models';
import { type FloorTab, floorTabs, HOME_TAB, newPlanId } from './model';
import type { PlanEditor } from './plan-editor';
import { updateNoticeStyles } from './version';
import { DeviceControls, deviceControlStyles } from './device-controls';
import { PlanView, planViewStyles } from './plan-view';
import { isHeatLayer } from './heat/functions';
import { button, h } from './ui';
import { ViewerController } from './viewer';

interface PanelInfo {
  config?: { version?: string };
}

const TAB_KEY = 'chartroom:tab';
const UNDERLAY_KEY = 'chartroom:underlay';
const LAYER_KEY = 'chartroom:layer';
const MESH_KEY = 'chartroom:mesh';
/** Home Assistant's floors and areas settings. Home Assistant routes same-origin links itself. */
const AREAS_PATH = '/config/areas/dashboard';

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
  readonly #view = new PlanView();
  readonly #viewer = new ViewerController(this.#view, {
    el: this,
    place: (bar) => this.#sheet.append(bar),
    changed: (layer, mesh) => {
      if (layer) localStorage.setItem(LAYER_KEY, layer);
      else localStorage.removeItem(LAYER_KEY);
      if (mesh) localStorage.setItem(MESH_KEY, '1');
      else localStorage.removeItem(MESH_KEY);
    },
  });
  readonly #controls = new DeviceControls(this.#view, this, () => this.#viewer.shown());
  readonly #tabsEl: HTMLElement;
  readonly #status: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #editButton: HTMLButtonElement;
  readonly #menuButton: HTMLButtonElement;
  readonly #toolbarSlot: HTMLElement;
  readonly #inspectorSlot: HTMLElement;
  #plans: PlanSummary[] | null = null;
  #tabs: FloorTab[] = [];
  #tabsKey = '';
  /** The floor registry the tabs were built from. */
  #tabsFloors: Hass['floors'] | null = null;
  #tab: string | null = null;
  #planId: string | null = null;
  #plan: Plan | null = null;
  #editor: PlanEditor | null = null;
  #worker: ReturnType<typeof holdWorker> | null = null;
  #underlayPref = readUnderlayPref();
  readonly #underlayControls: HTMLElement;
  readonly #underlayToggle: HTMLButtonElement;
  readonly #underlayOpacity: HTMLInputElement;
  readonly #underlayIgnoredNote: HTMLElement;
  /** The stored plan's underlay was dropped on load for pointing outside Chartroom. */
  #underlayIgnored = false;
  #plansRequested = false;
  /** A plan was saved elsewhere while the editor was open: the panel catches up at Done. */
  #missed = false;
  readonly #sheet: HTMLElement;
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
    this.#underlayIgnoredNote = h(
      'p',
      { class: 'underlay-ignored', role: 'status', hidden: true },
      'This plan’s underlay pointed outside Chartroom, so it was not loaded. ',
      'Import the image again under Edit › Underlay.',
    );
    const stored = localStorage.getItem(LAYER_KEY);
    this.#viewer.setLayer(isHeatLayer(stored) ? stored : null);
    if (localStorage.getItem(MESH_KEY) === '1') this.#viewer.setMesh(true);
    this.#viewer.watch((planId) => this.#planSaved(planId));
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
      this.#underlayIgnoredNote,
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
    // The page's field worker, held while on the page: the heatmap finds it running.
    this.#worker?.release();
    this.#worker = holdWorker();
    this.#worker.ready.then(
      (v) => this.#setStatus('worker', `worker ${v} ready`),
      () => this.#setStatus('worker', 'worker unavailable'),
    );
    window.addEventListener('keydown', this.#onKey);
    this.#viewer.connect();
  }

  // Home Assistant may detach the panel and attach it again: release the layers meanwhile.
  // An open editor stays open, but its pending change is saved now rather than after the delay.
  disconnectedCallback(): void {
    void this.#editor?.flush();
    window.removeEventListener('keydown', this.#onKey);
    this.#viewer.disconnect();
    this.#worker?.release();
    this.#worker = null;
  }

  set hass(hass: Hass) {
    this.#viewer.hass = hass;
    if (!this.#plansRequested && hass.connection) {
      this.#plansRequested = true;
      void this.#refreshPlans();
    }
    // The tabs follow the floor registry, not states.
    if (this.#plans && hass.floors !== this.#tabsFloors) this.#renderTabs();
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

  get #isAdmin(): boolean {
    return this.#viewer.hass?.user?.is_admin ?? true;
  }

  #api(): ChartroomApi {
    const api = this.#viewer.api;
    if (!api) throw new Error('not connected');
    return api;
  }

  /**
   * Plan `planId` (null: any plan) was saved or deleted elsewhere (another tab or user), as the
   * viewer hears it. The tabs follow, and the plan on screen loads again. An open editor keeps its
   * own copy: the panel catches up at Done, and the editor's next save replaces the other one (the
   * last save wins).
   */
  #planSaved(planId: string | null): void {
    if (this.#editor) {
      this.#missed = true;
      return;
    }
    void this.#refreshPlans();
    if (planId === null || planId === this.#planId) void this.#reloadPlan();
  }

  /** Load the plan on screen again, keeping the pan and zoom. */
  async #reloadPlan(): Promise<void> {
    const planId = this.#planId;
    const url = this.#plan?.underlay?.url;
    if (!planId) return;
    // Not over a switch to another plan or an editor opened meanwhile (no `begin()`: a tab load
    // stays current). The plan's own tab may change: a save can move it to another floor.
    const current = (): boolean => !this.#editor && this.#planId === planId;
    try {
      const loaded = await this.#viewer.load(planId, current);
      if (!loaded) return;
      this.#plan = loaded.plan;
      this.#underlayIgnored = loaded.underlayIgnored;
      if (loaded.plan.underlay?.url !== url) void this.#loadUnderlay();
      else this.#renderUnderlayControls();
    } catch {
      // Deleted meanwhile: the refreshed tabs show that.
    }
  }

  async #refreshPlans(): Promise<void> {
    try {
      const plans = await this.#api().listPlans();
      this.#plans = plans;
      this.#setStatus('plans', `${plans.length} saved plan(s)`);
    } catch {
      this.#plans = [];
      this.#setStatus('plans', 'plans unavailable');
    }
    this.#tabsKey = '';
    this.#renderTabs();
  }

  #renderTabs(): void {
    this.#tabsFloors = this.#viewer.hass?.floors;
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
      this.#viewer.begin();
      this.#viewer.closeTime();
      this.#planId = null;
      this.#plan = null;
      this.#underlayIgnored = false;
      this.#view.setPlan(null);
      void this.#loadUnderlay();
      this.#editButton.hidden = true;
      this.#showEmpty(
        tab.key === HOME_TAB.key
          ? 'No floors in Home Assistant yet, and no saved plans.'
          : `No plan for ${tab.label} yet.`,
        tab,
      );
      return;
    }
    if (tab.plan_id === this.#planId && this.#plan) return;
    try {
      const loaded = await this.#viewer.load(tab.plan_id);
      if (!loaded) return;
      this.#planId = tab.plan_id;
      this.#plan = loaded.plan;
      this.#underlayIgnored = loaded.underlayIgnored;
      this.#showEmpty(null);
      this.#view.fit();
      void this.#loadUnderlay();
      this.#editButton.hidden = !this.#isAdmin;
      this.dataset['plan'] = tab.plan_id;
    } catch (err) {
      this.#showEmpty(`Could not load this plan: ${(err as Error).message ?? err}`);
    }
  }

  /** Fetch the current plan's underlay (if any) and show it in the read-only view. */
  async #loadUnderlay(): Promise<void> {
    const loading = this.#viewer.underlay.show(this.#planId, this.#plan?.underlay?.url ?? null);
    this.#renderUnderlayControls();
    await loading;
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
    // Only an admin can import the image again; anyone else just sees the plan without it.
    this.#underlayIgnoredNote.hidden = !this.#underlayIgnored || !!u || editing || !this.#isAdmin;
  }

  #showEmpty(text: string | null, tab?: FloorTab): void {
    this.#empty.hidden = text === null;
    this.#view.el.classList.toggle('hidden', text !== null);
    this.#viewer.layers.el.hidden = text !== null;
    if (text === null) return;
    const children: (HTMLElement | string)[] = [h('p', {}, text)];
    if (tab && !tab.plan_id && this.#isAdmin) {
      children.push(
        button('Create plan', () => void this.#createPlan(tab), { class: 'create primary' }),
        h('p', { class: 'hint' }, 'Draw the walls yourself, or import a drawing to trace over.'),
      );
      if (tab.key === HOME_TAB.key) {
        children.push(
          h(
            'p',
            { class: 'hint' },
            'Without floors, this plan covers every area. ',
            h('a', { href: AREAS_PATH }, 'Add floors'),
            ' to draw one plan per floor.',
          ),
        );
      }
    }
    this.#empty.replaceChildren(...children);
  }

  async #createPlan(tab: FloorTab): Promise<void> {
    await this.#viewer.save(newPlanId(tab), emptyPlan(tab.label, tab.floor_id));
    this.#planId = null;
    await this.#refreshPlans();
    await this.#selectTab(tab.key);
    await this.#toggleEditor();
  }

  async #savePlan(plan: Plan): Promise<void> {
    if (!this.#planId) throw new Error('no plan');
    await this.#viewer.save(this.#planId, plan);
    const before = this.#plan;
    this.#plan = plan;
    // The save replaced the stored plan, so the ignored underlay is gone from it for good.
    this.#underlayIgnored = false;
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
    this.#missed = false;
    this.#editor = new PlanEditor({
      view: this.#view,
      hass: () => this.#viewer.hass,
      underlay: this.#viewer.underlay,
      save: (plan) => this.#savePlan(plan),
      planId: this.#planId,
      plan: this.#plan,
      underlayIgnored: this.#underlayIgnored,
    });
    this.#toolbarSlot.replaceChildren(this.#editor.toolbar);
    this.#inspectorSlot.replaceChildren(this.#editor.inspector);
    this.#inspectorSlot.hidden = false;
    this.#editButton.textContent = 'Done';
    this.toggleAttribute('editing', true);
    this.#renderUnderlayControls();
  }

  /** The editor closing, so pressing Done again or switching tabs meanwhile waits for it. */
  #closing: Promise<void> | null = null;

  /** Close the editor; it stays open until an image it is uploading has landed and been saved. */
  #closeEditor(): Promise<void> {
    return (this.#closing ??= this.#finishEditor().finally(() => (this.#closing = null)));
  }

  async #finishEditor(): Promise<void> {
    const editor = this.#editor;
    if (!editor) return;
    // A failed upload Done waited for: its message would leave with the editor's toolbar.
    this.#setStatus('editor', await editor.close());
    this.#editor = null;
    this.#plan = editor.plan;
    this.#toolbarSlot.replaceChildren();
    this.#inspectorSlot.replaceChildren();
    this.#inspectorSlot.hidden = true;
    this.#editButton.textContent = 'Edit';
    this.toggleAttribute('editing', false);
    this.#view.setPlan(this.#plan);
    this.#controls.attach();
    // The image the plan ends with: already shown, unless its load failed.
    void this.#loadUnderlay();
    // Show what was saved elsewhere meanwhile, unless the editor's last save failed: then its
    // copy stays on screen, so Edit starts from it and saves it again.
    if (this.#missed && !editor.unsaved) this.#planSaved(null);
    this.#missed = false;
  }

  readonly #onKey = (e: KeyboardEvent): void => {
    this.#editor?.key(e);
  };

  #toggleMenu(): void {
    this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true }));
  }

  readonly #parts = new Map<string, string>();
  /** Set one part of the status line, or clear it (null). */
  #setStatus(part: string, text: string | null): void {
    if (text === null) {
      this.#parts.delete(part);
      delete this.#status.dataset[part];
    } else {
      this.#parts.set(part, text);
      this.#status.dataset[part] = text;
    }
    this.#status.textContent = [...this.#parts.values()].join(' · ');
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
  .underlay-ignored { position: absolute; left: 12px; bottom: 12px; max-width: min(360px, calc(100% - 80px));
    margin: 0; padding: 6px 10px; border-radius: 6px; font-size: 0.8rem; color: var(--secondary-text-color, #727272);
    background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent); }
  .empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 8px; color: var(--secondary-text-color, #727272); text-align: center; padding: 16px; }
  .empty .hint { font-size: 0.85rem; margin: 0; }
  .empty a { color: var(--primary-color, #03a9f4); }
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
