// The wall and room editor: tools, selection, dragging with snapping, an inspector for the
// selection, undo/redo and autosave. Loaded on demand by the panel (its own chunk).
import { autoPlace, deviceChoices, deviceLook } from './devices';
import { add, dist, frame, roundToMm, polygonArea } from './geometry';
import type { Hass } from './ha-types';
import { autosaver } from './editor/autosaver';
import { findItem, kindOps, titleOf } from './editor/kinds';
import { areaName, roomNameForAreas } from './editor/rooms';
import type {
  Autosaver,
  Items,
  Selection,
  ToolContext,
  ToolResult,
  ToolState,
} from './editor/models';
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
import type { Item, Kind, Tool } from './editor/types';
import { History } from './history';
import { areaChoices, entityArea, sourceChoices } from './model';
import { limitWarnings, materialsOf } from './plan/functions';
import type { Device, Door, Plan, Room, Source, Wall } from './plan/models';
import type { Point, SourceKind, Window } from './plan/types';
import {
  addDevice,
  addSource,
  areaFactor,
  moveEndpoint,
  scalePlan,
  setMaterial,
  twoPointFactor,
  updateDevice,
  updateOpening,
  updateRoom,
  updateSource,
  updateWall,
} from './plan/ops';
import {
  dataUrl,
  MAX_FILE_BYTES,
  planFileJson,
  planFileName,
  readPlanFile,
  underlayFileName,
} from './plan-file';
import type { PlanView } from './plan-view';
import { signalLimitWarnings } from './signal';
import { count } from './text';
import { button, field, h, numberInput, s, select, textInput } from './ui';
import { importUnderlay, UnderlayImage, uploadUnderlay } from './underlay';

export type { Tool } from './editor/types';

const SOURCE_KINDS: { value: SourceKind; label: string }[] = [
  { value: 'sensor', label: 'Temperature / humidity sensor' },
  { value: 'access_point', label: 'Wi-Fi access point' },
  { value: 'radio', label: 'Radio (Zigbee, Z-Wave, Thread…)' },
];

export interface EditorHost {
  view: PlanView;
  hass(): Hass | undefined;
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
    hint: 'Click to place a sensor, access point or radio; pick its entity on the right.',
  },
  {
    tool: 'device',
    key: 'e',
    hint: 'Drag an entity from the list onto the plan, or pick it and click. Auto-place uses areas.',
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
/** Autosave this long after the last change. */
const SAVE_DELAY_MS = 600;
/** An inspector section's content. */
type Fields = (HTMLElement | null)[];
/** Drag-and-drop type for an entity dragged from the Device list onto the plan. */
const ENTITY_MIME = 'application/x-chartroom-entity';

export class PlanEditor {
  readonly toolbar: HTMLElement;
  readonly inspector: HTMLElement;
  readonly #host: EditorHost;
  readonly #view: PlanView;
  readonly #history: History<Plan>;
  #s: ToolState = initialState;
  /** Set by close(), so an import still uploading its image doesn't commit afterwards. */
  #closed = false;
  readonly #saver: Autosaver<Plan>;
  readonly #saveState: HTMLElement;
  readonly #hint: HTMLElement;
  readonly #undoButton: HTMLButtonElement;
  readonly #redoButton: HTMLButtonElement;
  readonly #toolButtons = new Map<Tool, HTMLButtonElement>();
  /** The underlay image on screen, as a blob URL. */
  #underlayUrl: string | null = null;
  /** Fetches the image version the plan points at, after an import, Undo or Redo. */
  readonly #underlay: UnderlayImage;
  #lastClick = { t: 0, x: 0, y: 0 };
  /** What the Source tool places next. */
  #sourceKind: SourceKind = 'sensor';
  #deviceKey = '';
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
    this.#apply(placeDevice(this.#s, this.plan, entity, this.#view.toPlan(e)));
  };

  constructor(host: EditorHost) {
    this.#host = host;
    this.#view = host.view;
    this.#history = new History(host.plan);
    this.#saver = autosaver(
      (plan) => host.save(plan),
      SAVE_DELAY_MS,
      host.plan,
      (text, error) => this.#setSaveState(text, error),
    );
    // The panel may already have loaded the picture.
    this.#underlayUrl = host.view.underlayUrl;
    this.#underlay = new UnderlayImage(
      () => host.hass(),
      host.planId,
      (url) => this.#setUnderlayUrl(url),
      this.#underlayUrl ? (host.plan.underlay?.url ?? null) : null,
    );
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
    this.#underlay.sync(this.plan.underlay?.url ?? null);
  }

  get plan(): Plan {
    return this.#history.present;
  }

  /** Flush pending saves and detach from the view. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#underlay.close();
    await this.#saver.flush();
    this.#view.setDelegate(null);
    this.#view.drawOverlay();
    this.#view.setEditing(null);
    this.#view.el.removeEventListener('dragover', this.#onDragOver);
    this.#view.el.removeEventListener('drop', this.#onDrop);
  }

  hassChanged(): void {
    const k = this.#s.selection?.kind;
    if (this.#s.tool === 'device' || k === 'device') {
      // States change all the time; only redraw the list when the entities on offer change (a
      // redraw mid-drag would drop the item being dragged).
      if (this.#deviceListKey() !== this.#deviceKey) this.#renderInspector();
      return;
    }
    if (!k || k === 'room' || k === 'source') this.#renderInspector();
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
    if (r.commit && this.#history.commit(r.commit)) this.#afterChange();
    else if (next !== prev) this.#render();
    return !r.pass;
  }

  #ctx(): ToolContext {
    return {
      plan: this.plan,
      radius: SNAP_PX * this.#view.mpp,
      addSource: (plan, p) => this.#addSource(plan, p),
    };
  }

  // ---- history and saving ----

  #commit(next: Plan): void {
    if (this.#history.commit(next)) this.#afterChange();
  }

  undo(): void {
    if (this.#history.undo() === undefined) return;
    this.#dropStaleSelection();
    this.#afterChange();
  }

  redo(): void {
    if (this.#history.redo() === undefined) return;
    this.#dropStaleSelection();
    this.#afterChange();
  }

  #dropStaleSelection(): void {
    const sel = this.#s.selection;
    if (sel && !findItem(this.plan, sel)) this.#s = { ...this.#s, selection: null };
  }

  #afterChange(): void {
    // Undo and Redo may go back to another image: each stored image keeps its own URL.
    this.#underlay.sync(this.plan.underlay?.url ?? null);
    this.#render();
    this.#saver.schedule(this.plan);
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
    // A drag redraws the plan; the drawing cursor only the overlay.
    if (next.drag) this.#render();
    else this.#renderOverlay();
  }

  // ---- rendering ----

  #render(): void {
    const { tool } = this.#s;
    for (const [t, b] of this.#toolButtons) b.setAttribute('aria-pressed', String(t === tool));
    this.#hint.textContent = TOOLS.find((t) => t.tool === tool)?.hint ?? '';
    this.#view.setEditing(tool);
    this.#view.setPlan(this.#s.preview ?? this.plan, this.#s.selection);
    this.#view.setUnderlayUrl(this.#underlayUrl);
    this.#renderOverlay();
    if (!this.#s.drag) this.#renderInspector();
    this.#undoButton.disabled = !this.#history.canUndo;
    this.#redoButton.disabled = !this.#history.canRedo;
  }

  #renderOverlay(): void {
    const { tool, selection: sel, draft, measured, hover: cursor, preview } = this.#s;
    const plan = preview ?? this.plan;
    const k = this.#view.mpp;
    const r = 5 * k;
    const out: SVGElement[] = [];
    const dot = (cls: string, [cx, cy]: Point, size = r, handle?: string): void => {
      out.push(s('circle', { class: cls, 'data-handle': handle, cx, cy, r: size }));
    };
    if (tool === 'select' && sel?.kind === 'wall') {
      const wall = plan.walls.find((w) => w.id === sel.id);
      if (wall)
        for (const end of ['a', 'b'] as const)
          dot('handle', wall[end], r * 1.4, `endpoint|${wall.id}|${end}`);
    }
    if (tool === 'select' && sel?.kind === 'room') {
      const room = plan.rooms.find((x) => x.id === sel.id);
      room?.polygon.forEach((pt, i) => dot('handle', pt, r, `vertex|${room.id}|${i}`));
    }
    const hover = cursor?.point;
    const chain = [...draft, ...(hover && draft.length > 0 ? [hover] : [])];
    if (chain.length > 1) {
      const pts = chain.map((q) => q.join(',')).join(' ');
      out.push(
        s(tool === 'room' ? 'polygon' : 'polyline', {
          class: `draft ${tool}`,
          points: pts,
        }),
      );
      const a = chain.at(-2)!;
      const b = chain.at(-1)!;
      out.push(
        s(
          'text',
          {
            class: 'measure-label',
            x: (a[0] + b[0]) / 2,
            y: (a[1] + b[1]) / 2 - 2 * r,
            'font-size': 12 * k,
          },
          `${dist(a, b).toFixed(2)} m`,
        ),
      );
    }
    for (const q of draft) dot('draft-point', q);
    if (measured) {
      const [a, b] = measured;
      out.push(s('line', { class: 'draft measure', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
      for (const q of measured) dot('draft-point', q);
    }
    if (hover && tool !== 'select')
      dot(cursor?.target ? 'cursor target' : 'cursor', hover, r * 0.8);
    this.#view.drawOverlay(...out);
  }

  #renderInspector(): void {
    const plan = this.plan;
    const { tool, selection: sel, measured } = this.#s;
    const parts: (HTMLElement | null)[] = [this.#warningsPanel()];
    if (tool === 'source' && !sel) parts.push(this.#newSourcePanel());
    if (tool === 'device' && !sel) parts.push(this.#devicesPanel());
    if (measured) parts.push(this.#measurePanel(measured));
    if (sel) parts.push(this.#itemPanel(sel));
    else if (tool !== 'device') parts.push(this.#planPanel(), this.#filePanel());
    if (tool === 'device' || sel?.kind === 'device') this.#deviceKey = this.#deviceListKey();
    if (!sel && tool !== 'source' && tool !== 'device')
      parts.push(this.#underlayPanel(), this.#materialsPanel());
    this.inspector.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
    this.inspector.dataset['selection'] = sel ? `${sel.kind}:${sel.id}` : '';
    this.inspector.dataset['walls'] = String(plan.walls.length);
  }

  #section(title: string, kind: string, ...children: (HTMLElement | null)[]): HTMLElement {
    return h('section', { 'data-panel': kind }, h('h2', {}, title), ...children);
  }

  /** Each kind's inspector fields; `#itemPanel` adds the title and the Delete button. */
  readonly #panels: { readonly [K in Kind]: (item: Items[K]) => Fields } = {
    wall: (w) => this.#wallPanel(w),
    room: (r) => this.#roomPanel(r),
    door: (o) => this.#openingPanel(o),
    window: (o) => this.#openingPanel(o),
    source: (x) => this.#sourcePanel(x),
    device: (d) => this.#devicePanel(d),
  };

  #itemPanel(sel: Selection): HTMLElement | null {
    const item = findItem(this.plan, sel);
    if (!item) return null;
    const label = titleOf(sel.kind);
    return this.#section(
      label,
      sel.kind,
      ...(this.#panels[sel.kind] as (item: Item) => Fields)(item),
      button(`Delete ${label.toLowerCase()}`, () => this.#deleteSelection(), {
        class: 'danger',
        'data-action': 'delete',
      }),
    );
  }

  #materialOptions(): { value: string; label: string }[] {
    return [...materialsOf(this.plan).values()].map((m) => ({ value: m.id, label: m.name }));
  }

  #wallPanel(wall: Wall): Fields {
    const { id } = wall;
    const length = frame(wall).length;
    return [
      field(
        'Material',
        select(
          this.#materialOptions(),
          wall.material,
          (v) => this.#commit(updateWall(this.plan, id, { material: v })),
          {
            name: 'material',
          },
        ),
      ),
      field(
        'Thickness (cm)',
        numberInput(
          roundToMm(wall.thickness * 100),
          (v) => this.#commit(updateWall(this.plan, id, { thickness: v / 100 })),
          { name: 'thickness', min: 1, max: 100, step: 0.5 },
        ),
      ),
      field(
        'Length (m)',
        numberInput(
          roundToMm(length),
          (v) => {
            if (v <= 0.05) return;
            const { u } = frame(wall);
            this.#commit(moveEndpoint(this.plan, wall.b, add(wall.a, [u[0] * v, u[1] * v])));
          },
          { name: 'length', min: 0.05, step: 0.01 },
        ),
      ),
      h('p', { class: 'meta' }, `${wall.id}`),
    ];
  }

  #openingPanel(o: Door | Window): Fields {
    const { id } = o;
    const isDoor = 'hinge' in o;
    const set = (patch: Partial<Omit<Door, 'id' | 'wall'>>): void =>
      this.#commit(updateOpening(this.plan, id, patch));
    return [
      field(
        'Width (cm)',
        numberInput(roundToMm(o.width * 100), (v) => set({ width: v / 100 }), {
          name: 'width',
          min: 10,
          step: 1,
        }),
      ),
      field(
        'Material',
        select(this.#materialOptions(), o.material, (v) => set({ material: v }), {
          name: 'material',
        }),
      ),
      field(
        'Thickness (cm)',
        numberInput(roundToMm(o.thickness * 100), (v) => set({ thickness: v / 100 }), {
          name: 'thickness',
          min: 0.1,
          step: 0.1,
        }),
      ),
      field(
        isDoor ? 'Sensor (optional)' : 'Sensor (optional)',
        textInput(o.entity_id ?? '', (v) => set({ entity_id: v.trim() || undefined }), {
          name: 'entity_id',
          placeholder: 'binary_sensor.…',
        }),
      ),
      isDoor
        ? h(
            'div',
            { class: 'row' },
            button('Flip hinge', () => set({ hinge: (o as Door).hinge === 'a' ? 'b' : 'a' }), {
              'data-action': 'flip-hinge',
            }),
            button('Flip swing', () => set({ swing: (o as Door).swing === 1 ? -1 : 1 }), {
              'data-action': 'flip-swing',
            }),
          )
        : null,
    ];
  }

  /** The room's linked Home Assistant areas, each with an unlink button, and a picker to add one. */
  #roomAreasField(room: Room): HTMLElement {
    const hass = this.#host.hass();
    const linked = room.area_ids ?? [];
    const names = (ids: readonly string[]): string[] => ids.map((a) => areaName(hass, a));
    const setAreas = (ids: string[]): void => {
      const fallback = `Room ${this.plan.rooms.indexOf(room) + 1}`;
      const name = roomNameForAreas(room.name, names(linked), names(ids), fallback);
      this.#commit(updateRoom(this.plan, room.id, { area_ids: ids, name }));
    };
    const free = areaChoices(hass, this.plan.floor_id ?? null).filter(
      (a) => !linked.includes(a.area_id),
    );
    const rows = linked.map((id) =>
      h(
        'div',
        { class: 'row', 'data-area-id': id },
        areaName(hass, id),
        button('×', () => setAreas(linked.filter((a) => a !== id)), {
          'data-action': 'unlink-area',
          'aria-label': `Unlink ${areaName(hass, id)}`,
        }),
      ),
    );
    const add = select(
      [
        { value: '', label: linked.length > 0 ? 'Add an area…' : '— none —' },
        ...free.map((a) => ({ value: a.area_id, label: a.name })),
      ],
      '',
      (v) => v && setAreas([...linked, v]),
      { name: 'area', 'aria-label': 'Link an area' },
    );
    return h('div', { class: 'field' }, h('span', {}, 'Home Assistant areas'), ...rows, add);
  }

  #roomPanel(room: Room): Fields {
    const { id } = room;
    const area = polygonArea(room.polygon);
    let target = area;
    return [
      field(
        'Name',
        textInput(
          room.name,
          (v) => v.trim() && this.#commit(updateRoom(this.plan, id, { name: v.trim() })),
          { name: 'name' },
        ),
      ),
      this.#roomAreasField(room),
      h('p', { class: 'meta', 'data-area': area.toFixed(2) }, `${area.toFixed(2)} m² drawn`),
      h(
        'div',
        { class: 'calibrate' },
        field(
          'Real area (m²)',
          numberInput(roundToMm(area), (v) => (target = v), {
            name: 'real-area',
            min: 0.1,
            step: 0.1,
          }),
        ),
        button(
          'Scale plan to match',
          () => {
            if (!(target > 0) || Math.abs(target - area) < 1e-6) return;
            this.#commit(scalePlan(this.plan, areaFactor(room.polygon, target)));
          },
          {
            'data-action': 'calibrate-area',
            title: 'Rescale the whole drawing (and underlay) so this room has the real area',
          },
        ),
      ),
    ];
  }

  #measurePanel([a, b]: readonly [Point, Point]): HTMLElement {
    const d = dist(a, b);
    let target = d;
    return this.#section(
      'Measure',
      'measure',
      h('p', { class: 'meta', 'data-distance': d.toFixed(3) }, `${d.toFixed(2)} m drawn`),
      field(
        'Real distance (m)',
        numberInput(roundToMm(d), (v) => (target = v), {
          name: 'real-distance',
          min: 0.01,
          step: 0.01,
        }),
      ),
      button(
        'Scale plan to match',
        () => {
          if (!(target > 0) || d === 0) return;
          this.#s = { ...this.#s, measured: null };
          this.#commit(scalePlan(this.plan, twoPointFactor(a, b, target)));
        },
        { 'data-action': 'calibrate-distance', class: 'primary' },
      ),
    );
  }

  #planPanel(): HTMLElement {
    const plan = this.plan;
    const floors = Object.values(this.#host.hass()?.floors ?? {});
    const area = plan.rooms.reduce((sum, r) => sum + polygonArea(r.polygon), 0);
    return this.#section(
      'Plan',
      'plan',
      field(
        'Name',
        textInput(plan.name, (v) => v.trim() && this.#commit({ ...plan, name: v.trim() }), {
          name: 'plan-name',
        }),
      ),
      field(
        'Floor',
        select(
          [
            { value: '', label: '— none —' },
            ...floors.map((f) => ({ value: f.floor_id, label: f.name })),
          ],
          plan.floor_id ?? '',
          (v) => this.#commit({ ...this.plan, floor_id: v || null }),
          { name: 'floor' },
        ),
      ),
      h(
        'p',
        { class: 'meta' },
        `${plan.walls.length} walls · ${plan.rooms.length} rooms · ${plan.doors.length} doors · ${plan.windows.length} windows · ${plan.sources.length} sources · ${plan.devices?.length ?? 0} devices · ${area.toFixed(1)} m²`,
      ),
    );
  }

  /** Export the plan as a .json file, or import one (with its underlay image file) over it. */
  #filePanel(): HTMLElement {
    const input = h('input', {
      type: 'file',
      accept: 'application/json,.json,image/png,image/jpeg,image/webp,image/svg+xml',
      multiple: true,
      name: 'plan-file',
    });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      if (files.length > 0) void this.#importPlan(files);
    });
    const report = this.#fileReport;
    return this.#section(
      'Plan file',
      'plan-file',
      h(
        'div',
        { class: 'row' },
        button('Export', () => void this.#exportPlan('none'), { 'data-action': 'export-plan' }),
        this.plan.underlay
          ? button('Export with underlay', () => void this.#exportPlan('embed'), {
              'data-action': 'export-plan-underlay',
              title: 'Embed the underlay image in the .json file',
            })
          : null,
        this.plan.underlay
          ? button('Export with underlay file', () => void this.#exportPlan('file'), {
              'data-action': 'export-plan-underlay-file',
              title: 'Save the underlay image as its own file next to the .json',
            })
          : null,
      ),
      field('Import (replaces this plan; pick the .json and its image file)', input),
      report
        ? h(
            'div',
            {
              class: report.error ? 'file-report error' : 'file-report',
              role: report.error ? 'alert' : 'status',
            },
            ...report.lines.map((line) => h('p', {}, line)),
          )
        : null,
    );
  }

  #report(error: boolean, lines: string[]): void {
    this.#fileReport = { error, lines };
    this.#renderInspector();
  }

  /** Download the plan, with its underlay image embedded or as a second file, or without it. */
  async #exportPlan(underlay: 'none' | 'embed' | 'file'): Promise<void> {
    let image: Blob | null = null;
    let imageName: string | null = null;
    try {
      if (underlay !== 'none') {
        if (!this.#underlayUrl) throw new Error('the underlay image is not loaded');
        image = await (await fetch(this.#underlayUrl)).blob();
        if (underlay === 'file') {
          imageName = underlayFileName(this.#host.planId, image.type);
          if (!imageName) throw new Error(`the underlay image is ${image.type || 'of no type'}`);
        }
      }
      const embedded = image && !imageName ? await dataUrl(image) : null;
      const json = planFileJson(this.plan, imageName ? { file: imageName } : embedded);
      download(new Blob([json], { type: 'application/json' }), planFileName(this.#host.planId));
      if (image && imageName) download(image, imageName);
    } catch (err) {
      this.#report(true, [`Export failed: ${(err as Error).message ?? err}`]);
    }
  }

  /** Replace the plan with a file's, after validating it; Undo brings the old one back. */
  async #importPlan(files: File[]): Promise<void> {
    const plans = files.filter((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (plans.length !== 1) {
      this.#report(true, [`Select one .json plan file (with its underlay image, if it has one).`]);
      return;
    }
    const file = plans[0]!;
    if (file.size > MAX_FILE_BYTES) {
      this.#report(true, [`${file.name}: the file is larger than 16 MB`]);
      return;
    }
    const r = await readPlanFile(
      await file.text(),
      this.#host.planId,
      this.plan.floor_id ?? null,
      files.filter((f) => f !== file),
    );
    if (this.#closed) return;
    if (!r.ok) {
      this.#report(true, [`${file.name} was not imported:`, ...r.problems]);
      return;
    }
    let plan = r.plan;
    let image: { url: string; blob: Blob } | null = null;
    if (r.image && plan.underlay) {
      const state = this.#saveState;
      const before = { text: state.textContent ?? '', error: state.classList.contains('error') };
      this.#setSaveState('Uploading image…');
      try {
        const url = await uploadUnderlay(this.#host.hass(), this.#host.planId, r.image);
        plan = { ...plan, underlay: { ...plan.underlay, url } };
        image = { url, blob: r.image };
      } catch (err) {
        this.#setSaveState(before.text, before.error);
        this.#report(true, [`${file.name} was not imported: ${(err as Error).message ?? err}`]);
        return;
      }
    }
    if (this.#closed) return;
    // Drop the old plan's selection, drafts and measurement, keeping the tool.
    this.#s = { ...initialState, tool: this.#s.tool };
    if (image) this.#underlay.set(image.url, image.blob);
    this.#commit(plan);
    this.#report(false, [`Imported ${file.name}.`, ...r.notes]);
    this.#view.fit();
  }

  #warningsPanel(): HTMLElement | null {
    const warnings = [...limitWarnings(this.plan), ...signalLimitWarnings(this.plan)];
    if (warnings.length === 0) return null;
    return h(
      'section',
      { 'data-panel': 'warnings', class: 'warnings', role: 'status' },
      ...warnings.map((w) => h('p', {}, w)),
    );
  }

  /** A new source at `p`: a sensor takes the first one on this floor not placed yet. */
  #addSource(plan: Plan, p: Point): { plan: Plan; id: string } {
    const kind = this.#sourceKind;
    let entity = '';
    if (kind === 'sensor') {
      const placed = new Set(plan.sources.map((x) => x.entity_id));
      entity =
        sourceChoices(this.#host.hass(), kind, plan.floor_id ?? null).find(
          (c) => !placed.has(c.entity_id),
        )?.entity_id ?? '';
    }
    return addSource(plan, kind, p, entity, entity ? entityArea(this.#host.hass(), entity) : null);
  }

  #newSourcePanel(): HTMLElement {
    return this.#section(
      'New source',
      'new-source',
      field(
        'Kind',
        select(SOURCE_KINDS, this.#sourceKind, (v) => (this.#sourceKind = v as SourceKind), {
          name: 'source-kind',
        }),
      ),
      h('p', { class: 'hint' }, 'Click on the plan to place it, then drag it into position.'),
    );
  }

  #sourcePanel(src: Source): Fields {
    const { id } = src;
    const hass = this.#host.hass();
    const floor = this.plan.floor_id ?? null;
    const set = (patch: Parameters<typeof updateSource>[2]): void =>
      this.#commit(updateSource(this.plan, id, patch));
    const pick = (v: string): void => {
      const entity = v.trim();
      set({ entity_id: entity, area_id: entity ? entityArea(hass, entity) : null });
    };
    const choices = sourceChoices(hass, src.kind, floor);
    const inArea = src.area_id ? areaName(hass, src.area_id) : null;
    let entityControl: HTMLElement;
    if (src.kind === 'sensor') {
      const opts = choices.map((c) => ({ value: c.entity_id, label: c.name }));
      if (src.entity_id && !opts.some((o) => o.value === src.entity_id))
        opts.unshift({ value: src.entity_id, label: `${src.entity_id} (not on this floor)` });
      entityControl = select(
        [
          { value: '', label: opts.length ? '— pick a sensor —' : '— no sensors on this floor —' },
          ...opts,
        ],
        src.entity_id,
        pick,
        { name: 'entity' },
      );
    } else {
      const list = h('datalist', { id: `entities-${id}` });
      for (const c of choices) list.append(h('option', { value: c.entity_id }, c.name));
      entityControl = h(
        'div',
        { class: 'combo' },
        textInput(src.entity_id, pick, {
          name: 'entity',
          list: `entities-${id}`,
          placeholder: 'sensor.…_rssi, device_tracker.…',
        }),
        list,
      );
    }
    return [
      field(
        'Kind',
        select(SOURCE_KINDS, src.kind, (v) => set({ kind: v as SourceKind }), {
          name: 'source-kind',
        }),
      ),
      field(src.kind === 'sensor' ? 'Sensor' : 'Entity', entityControl),
      src.kind === 'sensor'
        ? null
        : field(
            'Level at 1 m (dBm)',
            numberInput(src.tx_dbm ?? -40, (v) => set({ tx_dbm: v }), {
              name: 'tx-dbm',
              min: -120,
              max: 30,
              step: 1,
            }),
          ),
      h(
        'p',
        { class: 'meta', 'data-area': src.area_id ?? '' },
        `${inArea ? `In ${inArea}` : 'No area'} · ${src.position[0].toFixed(2)}, ${src.position[1].toFixed(2)} m`,
      ),
    ];
  }

  // ---- devices ----

  #deviceChoices(): ReturnType<typeof deviceChoices> {
    return deviceChoices(this.#host.hass(), this.plan.floor_id ?? null);
  }

  #deviceListKey(): string {
    const placed = (this.plan.devices ?? []).map((d) => d.entity_id).join();
    const choices = this.#deviceChoices()
      .map((c) => `${c.entity_id}=${c.name}@${c.area_id}`)
      .join();
    return `${placed}|${choices}|${this.#s.armed}`;
  }

  #autoPlace(): void {
    const spots = autoPlace(this.plan, this.#deviceChoices());
    let plan = this.plan;
    for (const s of spots) plan = addDevice(plan, s.entity_id, s.position).plan;
    this.#note =
      spots.length > 0
        ? `Placed ${count(spots.length, 'device')} in their rooms. Drag them where they really are.`
        : 'Nothing to place: link rooms to areas first, or every device in them is on the plan.';
    if (spots.length > 0) this.#commit(plan);
    else this.#renderInspector();
  }

  #devicesPanel(): HTMLElement {
    const hass = this.#host.hass();
    const placed = new Set((this.plan.devices ?? []).map((d) => d.entity_id));
    const free = this.#deviceChoices().filter((c) => !placed.has(c.entity_id));
    const areaOf = (a: string | null): string => (a ? areaName(hass, a) : 'No area');
    const list = h('ul', { class: 'entities', 'aria-label': 'Entities not on the plan' });
    for (const c of free) {
      const item = h(
        'li',
        {
          draggable: 'true',
          'data-entity': c.entity_id,
          'aria-pressed': String(this.#s.armed === c.entity_id),
          role: 'button',
          tabindex: 0,
          title: `${c.entity_id} — drag onto the plan, or click and then click the plan`,
        },
        h('span', { class: 'name' }, c.name),
        h('span', { class: 'meta' }, areaOf(c.area_id)),
      );
      const arm = (): void => {
        const { armed } = this.#s;
        this.#s = { ...this.#s, armed: armed === c.entity_id ? null : c.entity_id };
        this.#renderInspector();
      };
      item.addEventListener('click', arm);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          arm();
        }
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(ENTITY_MIME, c.entity_id);
        e.dataTransfer?.setData('text/plain', c.entity_id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      list.append(item);
    }
    const filter = h('input', {
      type: 'search',
      name: 'device-filter',
      placeholder: 'Filter',
      'aria-label': 'Filter entities',
    });
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const li of list.children) {
        const el = li as HTMLElement;
        el.hidden =
          q !== '' &&
          !el.textContent!.toLowerCase().includes(`${q}`) &&
          !el.dataset['entity']!.includes(q);
      }
    });
    return this.#section(
      'Devices',
      'devices',
      h(
        'p',
        { class: 'meta' },
        `${placed.size} on the plan · ${free.length} to place${this.plan.floor_id ? ' on this floor' : ''}`,
      ),
      button('Auto-place by area', () => this.#autoPlace(), { 'data-action': 'auto-place' }),
      this.#note ? h('p', { class: 'hint', role: 'status' }, this.#note) : null,
      free.length > 0 ? field('Entities', filter) : null,
      free.length > 0
        ? list
        : h(
            'p',
            { class: 'hint' },
            'Every light, switch, door, window, motion sensor, fan, cover and lock here is on the plan.',
          ),
    );
  }

  #devicePanel(dev: Device): Fields {
    const { id } = dev;
    const hass = this.#host.hass();
    const placed = new Set((this.plan.devices ?? []).map((d) => d.entity_id));
    const opts = this.#deviceChoices()
      .filter((c) => c.entity_id === dev.entity_id || !placed.has(c.entity_id))
      .map((c) => ({ value: c.entity_id, label: c.name }));
    if (!opts.some((o) => o.value === dev.entity_id))
      opts.unshift({ value: dev.entity_id, label: `${dev.entity_id} (not on this floor)` });
    const area = hass ? entityArea(hass, dev.entity_id) : null;
    const look = deviceLook(dev.entity_id, hass?.states?.[dev.entity_id]);
    return [
      field(
        'Entity',
        select(opts, dev.entity_id, (v) => this.#commit(updateDevice(this.plan, id, v)), {
          name: 'entity',
        }),
      ),
      h(
        'p',
        { class: 'meta', 'data-entity': dev.entity_id },
        `${look.label} · ${area ? (hass?.areas?.[area]?.name ?? area) : 'No area'} · ${dev.position[0].toFixed(2)}, ${dev.position[1].toFixed(2)} m`,
      ),
    ];
  }

  #materialsPanel(): HTMLElement {
    const rows = [...materialsOf(this.plan).values()].map((m) =>
      h(
        'tr',
        {},
        h('td', {}, m.name),
        h(
          'td',
          {},
          numberInput(
            m.db_per_cm,
            (v) => this.#commit(setMaterial(this.plan, { ...m, db_per_cm: v })),
            {
              name: `loss-${m.id}`,
              min: 0,
              step: 0.05,
              'aria-label': `${m.name} loss in dB per cm`,
            },
          ),
        ),
      ),
    );
    return this.#section(
      'Materials',
      'materials',
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Material'), h('th', {}, 'dB/cm'))),
        h('tbody', {}, ...rows),
      ),
    );
  }

  #underlayPanel(): HTMLElement {
    const u = this.plan.underlay;
    const input = h('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
      name: 'underlay',
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void this.#importUnderlay(file);
    });
    const opacity = h('input', {
      type: 'range',
      min: 0.1,
      max: 1,
      step: 0.05,
      value: String(u?.opacity ?? 0.5),
      name: 'opacity',
    });
    opacity.addEventListener('change', () => {
      const cur = this.plan.underlay;
      if (cur) this.#commit({ ...this.plan, underlay: { ...cur, opacity: opacity.valueAsNumber } });
    });
    return this.#section(
      'Underlay',
      'underlay',
      h(
        'p',
        { class: 'meta' },
        u
          ? `${u.width_px} × ${u.height_px} px · ${(u.width_px * u.scale).toFixed(2)} m wide`
          : 'A drawing to trace over (PNG, JPEG, WebP or SVG).',
      ),
      !u && this.#host.underlayIgnored
        ? h(
            'p',
            { class: 'hint', role: 'status', 'data-hint': 'underlay-ignored' },
            'The saved underlay pointed outside Chartroom, so it was not loaded. Import the image again.',
          )
        : null,
      field(u ? 'Replace image' : 'Import image', input),
      u ? field('Opacity', opacity) : null,
      u
        ? h('p', { class: 'hint' }, 'Calibrate with Measure (two points) or a room’s real area.')
        : null,
      u
        ? button('Remove underlay', () => this.#commit({ ...this.plan, underlay: null }), {
            class: 'danger',
            'data-action': 'remove-underlay',
          })
        : null,
    );
  }

  async #importUnderlay(file: File): Promise<void> {
    const hass = this.#host.hass();
    this.#setSaveState('Uploading image…');
    try {
      const { underlay, blob } = await importUnderlay(hass, this.#host.planId, file, this.plan);
      if (this.#closed) return;
      this.#underlay.set(underlay.url, blob);
      this.#commit({ ...this.plan, underlay });
      this.#view.fit();
    } catch (err) {
      this.#setSaveState(`Import failed: ${(err as Error).message ?? err}`, true);
    }
  }

  #setUnderlayUrl(url: string | null): void {
    // The view revokes the old blob URL when it gets the new one.
    this.#underlayUrl = url;
    this.#render();
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

/** Save `blob` as a download named `name`. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url));
}
