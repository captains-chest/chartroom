// The plan editor: the controller that wires the editing session (editor/session.ts), the tools
// (editor/tools.ts), the inspector's panels (editor/panels/) and plan files (editor/file-actions.ts)
// to the plan view, pointer and keyboard. Loaded on demand by the panel (its own chunk).
import { foldDevices, itemPrimary } from './device-entities';
import { autoPlace, deviceChoices } from './devices';
import { download, exportFiles, type ExportMode, readImport } from './editor/file-actions';
import { Inspector, type Part } from './editor/inspector';
import { findItem, kindOps, titleOf } from './editor/kinds';
import type { Selection, ToolContext, ToolResult, ToolState } from './editor/models';
import { overlayNodes } from './editor/overlay';
import type { PanelContext } from './editor/panels/context';
import { devicesPanel, type DeviceList, ENTITY_MIME } from './editor/panels/devices';
import { filePanel } from './editor/panels/file';
import { itemPanel } from './editor/panels/item';
import { materialsPanel } from './editor/panels/materials';
import { measurePanel } from './editor/panels/measure';
import { planPanel } from './editor/panels/plan';
import { newSourcePanel } from './editor/panels/source';
import { underlayPanel } from './editor/panels/underlay';
import { warningsPanel } from './editor/panels/warnings';
import { EditSession } from './editor/session';
import {
  closeRoom,
  down,
  escape,
  initialState,
  isDoubleClick,
  move,
  placeDevice,
  up,
  withTool,
} from './editor/tools';
import type { Kind, Tool } from './editor/types';
import type { Hass } from './ha-types';
import { sourceChoices } from './model';
import type { Plan } from './plan/models';
import type { Point, SourceKind } from './plan/types';
import { addDevice, addSource } from './plan/ops';
import type { PlanView } from './plan-view';
import { count } from './text';
import { button, h } from './ui';
import { importUnderlay, uploadUnderlay } from './underlay';
import type { UnderlayStore } from './underlay-store';

export type { Tool } from './editor/types';

export interface EditorHost {
  view: PlanView;
  hass(): Hass | undefined;
  /** The view's underlay image: the editor shows the version its plan points at. */
  underlay: UnderlayStore;
  save(plan: Plan): Promise<void>;
  planId: string;
  plan: Plan;
  /** The stored underlay was dropped on load for pointing outside Chartroom. */
  underlayIgnored?: boolean;
}

const TOOLS: { tool: Tool; key: string; hint: string }[] = [
  {
    tool: 'select',
    key: 'v',
    hint: 'Click to select, drag to move. Drag empty space to pan.',
  },
  {
    tool: 'wall',
    key: 'w',
    hint: 'Click to start, click for each corner. Esc or double-click ends.',
  },
  {
    tool: 'room',
    key: 'r',
    hint: 'Click each corner; click the first corner or press Enter to close.',
  },
  { tool: 'door', key: 'd', hint: 'Click on a wall to put a door there.' },
  { tool: 'window', key: 'n', hint: 'Click on a wall to put a window there.' },
  {
    tool: 'source',
    key: 's',
    hint: 'Click to place an access point or radio; pick its entity on the right.',
  },
  {
    tool: 'device',
    key: 'e',
    hint: 'Drag a device or sensor from the list onto the plan, or pick it and click. Auto-place uses areas.',
  },
  {
    tool: 'measure',
    key: 'm',
    hint: 'Click two points a known distance apart to calibrate the scale.',
  },
  {
    tool: 'underlay',
    key: 'u',
    hint: 'Import a drawing to trace over; drag to line it up.',
  },
];

/** Snap radius on screen. */
const SNAP_PX = 10;

export class PlanEditor {
  readonly toolbar: HTMLElement;
  readonly inspector: HTMLElement;
  readonly #inspector: Inspector;
  readonly #host: EditorHost;
  readonly #view: PlanView;
  /** The plan's history, saving, imports running and closing (no DOM). */
  readonly #session: EditSession;
  #s: ToolState = initialState;
  readonly #saveState: HTMLElement;
  readonly #hint: HTMLElement;
  readonly #undoButton: HTMLButtonElement;
  readonly #redoButton: HTMLButtonElement;
  readonly #toolButtons = new Map<Tool, HTMLButtonElement>();
  /** Shows the image version the plan points at, after an import, Undo or Redo. */
  readonly #underlay: UnderlayStore;
  #lastClick = { t: 0, x: 0, y: 0 };
  /** A drag's render waiting for the next frame (#renderSoon). */
  #frame = 0;
  /** What the Source tool places next. */
  #sourceKind: SourceKind = 'access_point';
  #note = '';
  /** What the last plan import or export said: problems (`error`) or notes. */
  #fileReport: { error: boolean; lines: string[] } | null = null;
  readonly #onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes(ENTITY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  readonly #onDrop = (e: DragEvent): void => {
    const entity = e.dataTransfer?.getData(ENTITY_MIME);
    if (!entity) return;
    e.preventDefault();
    this.#apply(
      placeDevice(this.#s, this.plan, entity, this.#view.toPlan(e), this.#deviceOf(entity)),
    );
  };

  constructor(host: EditorHost) {
    this.#host = host;
    this.#view = host.view;
    this.#session = new EditSession({
      // Sensors of one device placed apart (older plans) as one item: the next save stores it so.
      plan: foldDevices(host.plan, host.hass()),
      save: (plan) => host.save(plan),
      status: (text, error) => this.#setSaveState(text, error),
      connection: host.hass()?.connection,
    });
    this.#underlay = host.underlay;
    for (const t of TOOLS) {
      const label = titleOf(t.tool);
      const b = button(label, () => this.#setTool(t.tool), {
        'data-tool': t.tool,
        title: `${label} (${t.key.toUpperCase()})`,
      });
      this.#toolButtons.set(t.tool, b);
    }
    this.#undoButton = button('Undo', () => this.undo(), {
      'data-action': 'undo',
      title: 'Undo (Ctrl+Z)',
    });
    this.#redoButton = button('Redo', () => this.redo(), {
      'data-action': 'redo',
      title: 'Redo (Ctrl+Shift+Z)',
    });
    this.#saveState = h('span', { class: 'save-state', 'aria-live': 'polite' }, 'Saved');
    this.#hint = h('span', { class: 'hint' });
    this.toolbar = h(
      'div',
      { class: 'toolbar', role: 'toolbar', 'aria-label': 'Editor' },
      h('style', {}, editorStyles),
      h('div', { class: 'tools' }, ...this.#toolButtons.values()),
      h('div', { class: 'history' }, this.#undoButton, this.#redoButton),
      this.#hint,
      this.#saveState,
    );
    this.inspector = h('div', { class: 'inspector' });
    this.#inspector = new Inspector(this.inspector);
    this.#view.setDelegate({
      down: (p, e) => this.#down(p, e),
      move: (p) => this.#move(p),
      up: () => this.#apply(up(this.#s)),
      hover: (p) => this.#move(p),
      viewChanged: () => this.#renderOverlay(),
    });
    this.#view.el.addEventListener('dragover', this.#onDragOver);
    this.#view.el.addEventListener('drop', this.#onDrop);
    this.#setTool('select');
    this.#syncUnderlay();
  }

  get plan(): Plan {
    return this.#session.plan;
  }

  /** A change is not stored yet (after close: its last save failed). */
  get unsaved(): boolean {
    return this.#session.unsaved;
  }

  /** Save any pending change now, without closing (the panel left the page). */
  flush(): Promise<void> {
    return this.#session.flush();
  }

  /**
   * Close the session (it waits for imports still running and the last save), then detach from the
   * view. Resolves to what went wrong that the user would otherwise not see once the editor's
   * toolbar is gone (a failed import, an unsaved change), or null.
   */
  async close(): Promise<string | null> {
    const problem = await this.#session.close();
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#view.setDelegate(null);
    this.#view.drawOverlay();
    this.#view.setEditing(null);
    this.#view.el.removeEventListener('dragover', this.#onDragOver);
    this.#view.el.removeEventListener('drop', this.#onDrop);
    return problem;
  }

  /**
   * Home Assistant's states or registries changed: the inspector rebuilds only the parts that show
   * what changed (a redraw mid-drag would drop the device being dragged from the list, and one
   * mid-typing the field).
   */
  hassChanged(): void {
    // The entity registry may have come after the editor opened: fold the plan as the view does.
    const hass = this.#host.hass();
    if (this.#session.migrate((plan) => foldDevices(plan, hass))) {
      this.#dropStaleSelection();
      this.#render();
    } else this.#renderInspector();
  }

  #setTool(tool: Tool): void {
    this.#apply({ state: withTool(this.#s, tool) });
  }

  /** Take a tool step: commit its plan change and render. Whether the tool took the press. */
  #apply(r: ToolResult): boolean {
    const prev = this.#s;
    const next = (this.#s = r.state);
    // The auto-place note is stale after any change.
    if (r.commit || next.tool !== prev.tool) {
      this.#note = '';
      this.#fileReport = null;
    }
    if (r.commit && this.#session.commit(r.commit)) this.#afterChange();
    else if (next !== prev) this.#render();
    return !r.pass;
  }

  #ctx(): ToolContext {
    return {
      plan: this.plan,
      radius: SNAP_PX * this.#view.mpp,
      addSource: (plan, p) => this.#addSource(plan, p),
      deviceOf: (entity) => this.#deviceOf(entity),
    };
  }

  // ---- history and saving ----

  // Once closing has begun (the final save is under way), the session takes no more changes.
  #commit(next: Plan): void {
    if (this.#session.commit(next)) this.#afterChange();
  }

  undo(): void {
    if (!this.#session.undo()) return;
    this.#dropStaleSelection();
    this.#afterChange();
  }

  redo(): void {
    if (!this.#session.redo()) return;
    this.#dropStaleSelection();
    this.#afterChange();
  }

  #dropStaleSelection(): void {
    const sel = this.#s.selection;
    if (sel && !findItem(this.plan, sel)) this.#s = { ...this.#s, selection: null };
  }

  /** The plan changed: show its underlay image (Undo may go back to another) and draw it. */
  #afterChange(): void {
    this.#syncUnderlay();
    this.#render();
  }

  #setSaveState(text: string, error = false): void {
    this.#saveState.textContent = text;
    this.#saveState.classList.toggle('error', error);
  }

  // ---- keyboard ----

  key(e: KeyboardEvent): void {
    const target = e.composedPath()[0] as HTMLElement | undefined;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod) {
      return;
    } else if (e.key === 'Escape') {
      this.#apply({ state: escape(this.#s) });
    } else if (e.key === 'Enter' && this.#s.tool === 'room') {
      this.#apply(closeRoom(this.#s, this.plan));
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.#s.selection) {
      e.preventDefault();
      this.#deleteSelection();
    } else {
      const t = TOOLS.find((x) => x.key === k);
      if (t) this.#setTool(t.tool);
    }
  }

  #deleteSelection(): void {
    const sel = this.#s.selection;
    if (!sel) return;
    this.#s = { ...this.#s, selection: null };
    this.#commit(kindOps(sel.kind).remove(this.plan, sel.id));
  }

  // ---- pointer ----

  #down(p: Point, e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    const click = { t: performance.now(), x: e.clientX, y: e.clientY };
    const double = isDoubleClick(this.#lastClick, click);
    this.#lastClick = click;
    const target = e.target as Element | null;
    const handle = target?.closest<SVGElement>('[data-handle]')?.dataset['handle'];
    const el = target?.closest<SVGElement>('[data-kind]');
    const kind = el?.dataset['kind'] as Kind | undefined;
    const id = el?.dataset['id'];
    const hit = kind && id ? { kind, id } : null;
    return this.#apply(down(this.#s, this.#ctx(), { p, double, handle, hit }));
  }

  #move(p: Point): void {
    const next = move(this.#s, this.#ctx(), p);
    if (next === this.#s) return;
    this.#s = next;
    // A drag redraws the plan, once a frame; the drawing cursor only the overlay.
    if (next.drag) this.#renderSoon();
    else this.#renderOverlay();
  }

  /** Pointer moves can come faster than the screen draws: render once in the next frame. */
  #renderSoon(): void {
    if (typeof requestAnimationFrame !== 'function') return this.#render();
    this.#frame ||= requestAnimationFrame(() => {
      this.#frame = 0;
      if (!this.#session.closed) this.#render();
    });
  }

  // ---- rendering ----

  #render(): void {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    const { tool } = this.#s;
    for (const [t, b] of this.#toolButtons) b.setAttribute('aria-pressed', String(t === tool));
    this.#hint.textContent = TOOLS.find((t) => t.tool === tool)?.hint ?? '';
    this.#view.setEditing(tool);
    this.#view.setPlan(this.#s.preview ?? this.plan, this.#s.selection, !!this.#s.drag);
    this.#renderOverlay();
    if (!this.#s.drag) this.#renderInspector();
    this.#undoButton.disabled = !this.#session.canUndo;
    this.#redoButton.disabled = !this.#session.canRedo;
  }

  #renderOverlay(): void {
    const plan = this.#s.preview ?? this.plan;
    this.#view.drawOverlay(...overlayNodes(this.#s, plan, this.#view.mpp));
  }

  /**
   * The inspector's parts for the current tool and selection, each with what it is built from;
   * only parts whose inputs changed are rebuilt.
   */
  #renderInspector(): void {
    const plan = this.plan;
    const hass = this.#host.hass();
    const { tool, selection: sel, measured } = this.#s;
    const parts: Part[] = [{ key: 'warnings', deps: [plan], build: () => warningsPanel(plan) }];
    if (tool === 'source' && !sel)
      parts.push({
        key: 'new-source',
        deps: [],
        build: () => newSourcePanel(this.#sourceKind, (kind) => (this.#sourceKind = kind)),
      });
    if (tool === 'device' && !sel)
      parts.push({
        key: 'devices',
        deps: [this.#deviceListKey(), hass?.areas, this.#note, plan.floor_id],
        build: () => devicesPanel(this.#panel, this.#deviceList()),
      });
    if (measured)
      parts.push({
        key: 'measure',
        deps: [measured],
        build: () =>
          measurePanel(this.#panel, measured, () => (this.#s = { ...this.#s, measured: null })),
      });
    if (sel)
      parts.push({
        key: `item:${sel.kind}:${sel.id}`,
        deps: [
          findItem(plan, sel),
          plan.materials,
          plan.floor_id,
          ...this.#itemHassDeps(sel, hass),
        ],
        build: () => itemPanel(this.#panel, sel, () => this.#deleteSelection()),
      });
    else if (tool !== 'device')
      parts.push(
        { key: 'plan', deps: [plan, hass?.floors], build: () => planPanel(this.#panel) },
        {
          key: 'plan-file',
          deps: [!!plan.underlay, this.#fileReport],
          build: () =>
            filePanel(this.#panel, {
              report: this.#fileReport,
              exportPlan: (mode) => this.#exportPlan(mode),
              importFiles: (files) => {
                if (!this.#session.closed) this.#session.track(this.#importPlan(files));
              },
            }),
        },
      );
    if (!sel && tool !== 'source' && tool !== 'device')
      parts.push(
        {
          key: 'underlay',
          deps: [plan.underlay, this.#host.underlayIgnored],
          build: () =>
            underlayPanel(this.#panel, !!this.#host.underlayIgnored, (file) => {
              if (!this.#session.closed) this.#session.track(this.#importUnderlay(file));
            }),
        },
        { key: 'materials', deps: [plan.materials], build: () => materialsPanel(this.#panel) },
      );
    this.#inspector.render(parts);
    this.inspector.dataset['selection'] = sel ? `${sel.kind}:${sel.id}` : '';
    this.inspector.dataset['walls'] = String(plan.walls.length);
  }

  /** What the panels see of the editor: the plan now, Home Assistant, and committing. */
  readonly #panel: PanelContext = (() => {
    const plan = (): Plan => this.plan;
    const hass = (): Hass | undefined => this.#host.hass();
    return {
      get plan() {
        return plan();
      },
      get hass() {
        return hass();
      },
      commit: (next: Plan) => this.#commit(next),
    };
  })();

  #deviceList(): DeviceList {
    return {
      choices: this.#deviceChoices(),
      armed: this.#s.armed,
      note: this.#note,
      arm: (entity) => {
        const { armed } = this.#s;
        this.#s = { ...this.#s, armed: armed === entity ? null : entity };
        this.#renderInspector();
      },
      autoPlace: () => this.#autoPlace(),
    };
  }

  /** What of Home Assistant an item's panel shows: its pickers' choices, names, its state. */
  #itemHassDeps(sel: Selection, hass: Hass | undefined): unknown[] {
    const plan = this.plan;
    switch (sel.kind) {
      case 'room':
        return [hass?.areas];
      case 'source': {
        const choices = sourceChoices(hass, plan.floor_id ?? null);
        return [
          hass?.areas,
          hass?.entities,
          hass?.devices,
          choices.map((c) => `${c.entity_id}=${c.name}@${c.area_id}`).join(),
        ];
      }
      case 'device': {
        const dev = plan.devices?.find((d) => d.id === sel.id);
        return [
          hass?.areas,
          hass?.entities,
          hass?.devices,
          this.#deviceListKey(),
          dev && itemPrimary(plan, hass, dev),
          dev && hass?.states?.[itemPrimary(plan, hass, dev)],
        ];
      }
      default:
        return [];
    }
  }

  #report(error: boolean, lines: string[]): void {
    this.#fileReport = { error, lines };
    this.#renderInspector();
  }

  /** Download the plan, with its underlay image embedded or as a second file, or without it. */
  async #exportPlan(mode: ExportMode): Promise<void> {
    try {
      const url = this.plan.underlay?.url;
      const image = url ? this.#underlay.blob(url) : null;
      for (const f of await exportFiles(this.plan, this.#host.planId, image, mode))
        download(f.blob, f.name);
    } catch (err) {
      this.#report(true, [`Export failed: ${(err as Error).message ?? err}`]);
    }
  }

  /**
   * Replace the plan with a file's, after validating it; Undo brings the old one back. Resolves to
   * the problem when it was not imported.
   */
  async #importPlan(files: File[]): Promise<string | null> {
    const { planId } = this.#host;
    const r = await readImport(
      files,
      planId,
      this.plan.floor_id ?? null,
      (image) =>
        this.#uploading(() =>
          uploadUnderlay(this.#host.hass(), planId, image, this.#session.signal),
        ),
      () => this.#session.closed,
    );
    if (!r) return null;
    if (!r.ok) {
      this.#report(true, r.lines);
      return r.lines.join(' ');
    }
    // Drop the old plan's selection, drafts and measurement, keeping the tool.
    this.#s = { ...initialState, tool: this.#s.tool };
    if (r.image) this.#underlay.put(r.image.url, r.image.blob);
    this.#commit(foldDevices(r.plan, this.#host.hass()));
    this.#report(false, [`Imported ${r.file.name}.`, ...r.notes]);
    this.#view.fit();
    return null;
  }

  /** Show "Uploading image…" while `upload` runs; a failure puts the save state back. */
  async #uploading<T>(upload: () => Promise<T>): Promise<T> {
    const state = this.#saveState;
    const before = { text: state.textContent ?? '', error: state.classList.contains('error') };
    this.#setSaveState('Uploading image…');
    try {
      return await upload();
    } catch (err) {
      this.#setSaveState(before.text, before.error);
      throw err;
    }
  }

  /** A new access point or radio at `p`, its entity picked afterwards. */
  #addSource(plan: Plan, p: Point): { plan: Plan; id: string } {
    return addSource(plan, this.#sourceKind, p);
  }

  #deviceOf(entity: string): string | null {
    return this.#host.hass()?.entities?.[entity]?.device_id ?? null;
  }

  // ---- devices ----

  #deviceChoices(): ReturnType<typeof deviceChoices> {
    return deviceChoices(this.#host.hass(), this.plan.floor_id ?? null);
  }

  #deviceListKey(): string {
    const placed = (this.plan.devices ?? []).map((d) => `${d.entity_id}/${d.device_id}`).join();
    const choices = this.#deviceChoices()
      .map((c) => `${c.entity_id}=${c.name}@${c.area_id}`)
      .join();
    return `${placed}|${choices}|${this.#s.armed}`;
  }

  #autoPlace(): void {
    const spots = autoPlace(this.plan, this.#deviceChoices());
    let plan = this.plan;
    for (const s of spots)
      plan = addDevice(plan, s.choice.entity_id, s.position, s.choice.device_id).plan;
    this.#note =
      spots.length > 0
        ? `Placed ${count(spots.length, 'device')} in their rooms. Drag them where they really are.`
        : 'Nothing to place: link rooms to areas first, or every device in them is on the plan.';
    if (spots.length > 0) this.#commit(plan);
    else this.#renderInspector();
  }

  /** Upload and place a new underlay image. Resolves to the problem when it failed. */
  async #importUnderlay(file: File): Promise<string | null> {
    const hass = this.#host.hass();
    this.#setSaveState('Uploading image…');
    try {
      const { underlay, blob } = await importUnderlay(
        hass,
        this.#host.planId,
        file,
        this.plan,
        this.#session.signal,
      );
      if (this.#session.closed) return null;
      this.#underlay.put(underlay.url, blob);
      this.#commit({ ...this.plan, underlay });
      this.#view.fit();
      return null;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.#setSaveState(`Import failed: ${message}`, true);
      return `The underlay image was not imported: ${message}`;
    }
  }

  /** Undo and Redo may go back to another image: each stored image keeps its own URL. */
  #syncUnderlay(): void {
    void this.#underlay.show(this.#host.planId, this.plan.underlay?.url ?? null);
  }
}

const editorStyles = `
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 16px;
    background: var(--card-background-color, #fff); border-bottom: 1px solid var(--divider-color, #ddd); }
  .tools, .history { display: flex; gap: 4px; }
  .toolbar .hint { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--secondary-text-color, #727272); font-size: 0.85rem; }
  .toolbar .save-state { margin-left: auto; white-space: nowrap; }
  .save-state { font-size: 0.85rem; color: var(--secondary-text-color, #727272); }
  .save-state.error { color: var(--error-color, #db4437); }
  .inspector { padding: 8px 16px 16px; }
  .inspector h2 { font-size: 1rem; font-weight: 500; margin: 12px 0 8px; }
  .inspector section + section { border-top: 1px solid var(--divider-color, #ddd); margin-top: 12px; }
  .field { display: flex; flex-direction: column; gap: 2px; margin: 0 0 8px; font-size: 0.85rem; }
  .field span { color: var(--secondary-text-color, #727272); }
  .field input, .field select { font: inherit; padding: 4px 6px; border-radius: 4px; min-width: 0;
    border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: inherit; }
  .inspector .row { display: flex; gap: 6px; margin: 0 0 8px; }
  .inspector .meta { font-size: 0.8rem; color: var(--secondary-text-color, #727272); margin: 0 0 8px; }
  .inspector .hint { font-size: 0.8rem; color: var(--secondary-text-color, #727272); }
  .inspector .calibrate { border-left: 3px solid var(--divider-color, #ddd); padding-left: 8px; margin: 0 0 8px; }
  .inspector table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .inspector td, .inspector th { text-align: left; padding: 2px 0; }
  .inspector td input { width: 64px; font: inherit; }
  button.danger { color: var(--error-color, #db4437); }
  svg.editing { cursor: default; }
  svg.editing[data-tool=wall], svg.editing[data-tool=room], svg.editing[data-tool=measure],
  svg.editing[data-tool=door], svg.editing[data-tool=window], svg.editing[data-tool=source] { cursor: crosshair; }
  svg.editing .source, svg.editing .device { cursor: move; }
  svg.editing[data-tool=device] { cursor: crosshair; }
  .inspector ul.entities { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow-y: auto; }
  .inspector ul.entities li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px;
    border-radius: 4px; cursor: grab; font-size: 0.85rem; border: 1px solid transparent; }
  .inspector ul.entities li:hover { border-color: var(--divider-color, #ddd); }
  .inspector ul.entities li[aria-pressed=true] { border-color: var(--primary-color, #03a9f4);
    background: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent); }
  .inspector ul.entities .meta { margin: 0; white-space: nowrap; }
  .inspector [data-action=auto-place] { margin: 0 0 8px; }
  .inspector .warnings { margin: 8px 0 0; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem;
    background: color-mix(in srgb, var(--warning-color, #ffa600) 15%, transparent);
    border-left: 3px solid var(--warning-color, #ffa600); }
  .inspector .warnings p { margin: 4px 0; }
  .inspector .file-report { font-size: 0.85rem; }
  .inspector .file-report p { margin: 4px 0; }
  .inspector .file-report.error { color: var(--error-color, #db4437); }
  .combo input { width: 100%; box-sizing: border-box; }
  svg.editing[data-tool=underlay] { cursor: move; }
  .handle { fill: var(--card-background-color, #fff); stroke: var(--primary-color, #03a9f4); stroke-width: 2px;
    vector-effect: non-scaling-stroke; cursor: move; }
  .draft { fill: none; stroke: var(--primary-color, #03a9f4); stroke-width: 2px; stroke-dasharray: 6 4;
    vector-effect: non-scaling-stroke; pointer-events: none; }
  .draft.room { fill: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent); }
  .draft.measure { stroke: var(--accent-color, #ff9800); }
  .draft-point { fill: var(--primary-color, #03a9f4); pointer-events: none; }
  .cursor { fill: none; stroke: var(--secondary-text-color, #777); stroke-width: 1.5px; vector-effect: non-scaling-stroke; pointer-events: none; }
  .cursor.target { stroke: var(--accent-color, #ff9800); stroke-width: 2.5px; }
  .measure-label { fill: var(--primary-text-color, #222); text-anchor: middle; pointer-events: none;
    paint-order: stroke; stroke: var(--primary-background-color, #fff); stroke-width: 3px; vector-effect: non-scaling-stroke; }
`;
