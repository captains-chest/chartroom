// The wall and room editor: tools, selection, dragging with snapping, an inspector for the
// selection, undo/redo and autosave. Loaded on demand by the panel (its own chunk).
import { autoPlace, deviceChoices, deviceLook } from './devices';
import { add, along, dist, frame, mm, sub } from './geometry';
import type { Hass } from './ha-types';
import { History } from './history';
import { areaChoices, entityArea, sourceChoices } from './model';
import {
  type Door,
  limitWarnings,
  materialsOf,
  type Opening,
  type Plan,
  type Point,
  polygonArea,
  type SourceKind,
} from './plan';
import {
  addDevice,
  addOpening,
  addRoom,
  addSource,
  addWall,
  areaFactor,
  deleteDevice,
  deleteOpening,
  deleteRoom,
  deleteSource,
  deleteWall,
  DEFAULT_WALL,
  moveDevice,
  moveEndpoint,
  moveOpening,
  moveRoom,
  moveRoomVertex,
  moveSource,
  moveWall,
  scalePlan,
  setMaterial,
  snap,
  snapTargets,
  twoPointFactor,
  updateDevice,
  updateOpening,
  updateRoom,
  updateSource,
  updateWall,
  wallAt,
} from './plan-ops';
import type { PlanView } from './plan-view';
import { signalLimitWarnings } from './signal';
import { button, field, h, numberInput, s, select, textInput } from './ui';
import { importUnderlay, loadUnderlayUrl } from './underlay';

export type Tool =
  | 'select'
  | 'wall'
  | 'room'
  | 'door'
  | 'window'
  | 'source'
  | 'device'
  | 'measure'
  | 'underlay';
type Kind = 'wall' | 'room' | 'door' | 'window' | 'source' | 'device';

const SOURCE_KINDS: { value: SourceKind; label: string }[] = [
  { value: 'sensor', label: 'Temperature / humidity sensor' },
  { value: 'access_point', label: 'Wi-Fi access point' },
  { value: 'radio', label: 'Radio (Zigbee, Z-Wave, Thread…)' },
];
interface Selection {
  kind: Kind;
  id: string;
}

type Drag =
  | { type: 'endpoint'; base: Plan; from: Point }
  | { type: 'wall'; base: Plan; id: string; start: Point }
  | { type: 'opening'; base: Plan; id: string }
  | { type: 'source'; base: Plan; id: string; start: Point; from: Point }
  | { type: 'device'; base: Plan; id: string; start: Point; from: Point }
  | { type: 'room'; base: Plan; id: string; start: Point }
  | { type: 'vertex'; base: Plan; id: string; index: number }
  | { type: 'underlay'; base: Plan; start: Point };

export interface EditorHost {
  view: PlanView;
  hass(): Hass | undefined;
  save(plan: Plan): Promise<void>;
  planId: string;
  plan: Plan;
}

const TOOLS: { tool: Tool; label: string; key: string; hint: string }[] = [
  {
    tool: 'select',
    label: 'Select',
    key: 'v',
    hint: 'Click to select, drag to move. Drag empty space to pan.',
  },
  {
    tool: 'wall',
    label: 'Wall',
    key: 'w',
    hint: 'Click to start, click for each corner. Esc or double-click ends.',
  },
  {
    tool: 'room',
    label: 'Room',
    key: 'r',
    hint: 'Click each corner; click the first corner or press Enter to close.',
  },
  { tool: 'door', label: 'Door', key: 'd', hint: 'Click on a wall to put a door there.' },
  { tool: 'window', label: 'Window', key: 'n', hint: 'Click on a wall to put a window there.' },
  {
    tool: 'source',
    label: 'Source',
    key: 's',
    hint: 'Click to place a sensor, access point or radio; pick its entity on the right.',
  },
  {
    tool: 'device',
    label: 'Device',
    key: 'e',
    hint: 'Drag an entity from the list onto the plan, or pick it and click. Auto-place uses areas.',
  },
  {
    tool: 'measure',
    label: 'Measure',
    key: 'm',
    hint: 'Click two points a known distance apart to calibrate the scale.',
  },
  {
    tool: 'underlay',
    label: 'Underlay',
    key: 'u',
    hint: 'Import a drawing to trace over; drag to line it up.',
  },
];

/** Snap radius on screen. */
const SNAP_PX = 10;
const SAVE_DELAY = 600;

const DOUBLE_CLICK_PX = 6;
/** Drag-and-drop type for an entity dragged from the Device list onto the plan. */
const ENTITY_MIME = 'application/x-chartroom-entity';

export class PlanEditor {
  readonly toolbar: HTMLElement;
  readonly inspector: HTMLElement;
  readonly #host: EditorHost;
  readonly #view: PlanView;
  readonly #history: History<Plan>;
  #tool: Tool = 'select';
  #selection: Selection | null = null;
  #drag: Drag | null = null;
  #moved = false;
  /** Points placed so far by the wall, room or measure tool. */
  #draft: Point[] = [];
  #hover: { point: Point; target: boolean } | null = null;
  #measured: [Point, Point] | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> | null = null;
  #savedPlan: Plan;
  #saveState: HTMLElement;
  #hint: HTMLElement;
  #undoButton: HTMLButtonElement;
  #redoButton: HTMLButtonElement;
  #toolButtons = new Map<Tool, HTMLButtonElement>();
  #underlayUrl: string | null = null;
  #lastClick = { t: 0, x: 0, y: 0 };
  /** What the Source tool places next. */
  #sourceKind: SourceKind = 'sensor';
  /** The entity the Device tool places on the next click. */
  #armed: string | null = null;
  #deviceKey = '';
  #note = '';
  readonly #onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer?.types.includes(ENTITY_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  readonly #onDrop = (e: DragEvent): void => {
    const entity = e.dataTransfer?.getData(ENTITY_MIME);
    if (!entity) return;
    e.preventDefault();
    this.#placeDevice(entity, this.#view.toPlan(e));
  };

  constructor(host: EditorHost) {
    this.#host = host;
    this.#view = host.view;
    this.#history = new History(host.plan);
    this.#savedPlan = host.plan;
    // The panel may already have loaded the picture.
    this.#underlayUrl = host.view.underlayUrl;
    for (const t of TOOLS) {
      const b = button(t.label, () => this.setTool(t.tool), {
        'data-tool': t.tool,
        title: `${t.label} (${t.key.toUpperCase()})`,
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
    this.#view.delegate = {
      down: (p, e) => this.#down(p, e),
      move: (p, e) => this.#move(p, e),
      up: (p, e) => this.#up(p, e),
      hover: (p, e) => this.#hoverAt(p, e),
    };
    this.#view.onViewChange = () => this.#renderOverlay();
    this.#view.svg.classList.add('editing');
    this.#view.svg.addEventListener('dragover', this.#onDragOver);
    this.#view.svg.addEventListener('drop', this.#onDrop);
    this.setTool('select');
    this.#render();
    void this.#loadUnderlay();
  }

  get plan(): Plan {
    return this.#history.present;
  }

  get tool(): Tool {
    return this.#tool;
  }

  get selection(): Selection | null {
    return this.#selection;
  }

  /** Flush pending saves and detach from the view. */
  async close(): Promise<void> {
    await this.flush();
    this.#view.delegate = null;
    this.#view.onViewChange = null;
    this.#view.overlay.replaceChildren();
    this.#view.svg.classList.remove('editing');
    this.#view.svg.removeEventListener('dragover', this.#onDragOver);
    this.#view.svg.removeEventListener('drop', this.#onDrop);
  }

  hassChanged(): void {
    const k = this.#selection?.kind;
    if (this.#tool === 'device' || k === 'device') {
      // States change all the time; only redraw the list when the entities on offer change (a
      // redraw mid-drag would drop the item being dragged).
      if (this.#deviceListKey() !== this.#deviceKey) this.#renderInspector();
      return;
    }
    if (!k || k === 'room' || k === 'source') this.#renderInspector();
  }

  setTool(tool: Tool): void {
    this.#tool = tool;
    this.#draft = [];
    this.#measured = null;
    for (const [t, b] of this.#toolButtons) b.setAttribute('aria-pressed', String(t === tool));
    this.#hint.textContent = TOOLS.find((t) => t.tool === tool)?.hint ?? '';
    this.#view.svg.dataset['tool'] = tool;
    if (tool === 'underlay' || tool === 'source' || tool === 'device') this.#selection = null;
    if (tool !== 'device') this.#armed = null;
    this.#note = '';
    this.#render();
  }

  select(sel: Selection | null): void {
    this.#selection = sel;
    this.#render();
  }

  // ---- history and saving ----

  #commit(next: Plan): void {
    if (!this.#history.commit(next)) return;
    this.#afterChange();
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
    const sel = this.#selection;
    if (sel && !this.#find(sel)) this.#selection = null;
  }

  #afterChange(): void {
    this.#render();
    this.#scheduleSave();
  }

  #scheduleSave(): void {
    this.#setSaveState(this.plan === this.#savedPlan ? 'Saved' : 'Unsaved changes');
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY);
  }

  /** Save now if anything changed since the last save. */
  async flush(): Promise<void> {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (this.#saving) await this.#saving;
    const plan = this.plan;
    if (plan === this.#savedPlan) {
      this.#setSaveState('Saved');
      return;
    }
    this.#setSaveState('Saving…');
    this.#saving = this.#host.save(plan).then(
      () => {
        this.#savedPlan = plan;
        this.#setSaveState(this.plan === plan ? 'Saved' : 'Unsaved changes');
      },
      (err: unknown) => this.#setSaveState(`Save failed: ${(err as Error).message ?? err}`, true),
    );
    await this.#saving;
    this.#saving = null;
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
      if (this.#draft.length > 0 || this.#measured) {
        this.#draft = [];
        this.#measured = null;
        this.#render();
      } else if (this.#tool !== 'select') this.setTool('select');
      else this.select(null);
    } else if (e.key === 'Enter' && this.#tool === 'room') {
      this.#closeRoom();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.#selection) {
      e.preventDefault();
      this.deleteSelection();
    } else {
      const t = TOOLS.find((x) => x.key === k);
      if (t) this.setTool(t.tool);
    }
  }

  deleteSelection(): void {
    const sel = this.#selection;
    if (!sel) return;
    const p = this.plan;
    const next =
      sel.kind === 'wall'
        ? deleteWall(p, sel.id)
        : sel.kind === 'room'
          ? deleteRoom(p, sel.id)
          : sel.kind === 'source'
            ? deleteSource(p, sel.id)
            : sel.kind === 'device'
              ? deleteDevice(p, sel.id)
              : deleteOpening(p, sel.id);
    this.#selection = null;
    this.#commit(next);
  }

  // ---- pointer ----

  #snapRadius(): number {
    return SNAP_PX * this.#view.mpp;
  }

  #snapped(
    p: Point,
    faces: boolean,
    exclude: Point | null = null,
  ): { point: Point; target: boolean } {
    return snap(p, {
      radius: this.#snapRadius(),
      grid: 0.05,
      anchor: this.#draft.at(-1) ?? null,
      targets: snapTargets(this.plan, faces),
      exclude,
    });
  }

  #down(p: Point, e: PointerEvent): boolean {
    if (e.button !== 0) return false;
    const now = performance.now();
    // A double click is two quick clicks in the same spot (quick clicks elsewhere are new points).
    const prev = this.#lastClick;
    const double =
      now - prev.t < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_CLICK_PX;
    this.#lastClick = { t: now, x: e.clientX, y: e.clientY };
    switch (this.#tool) {
      case 'select':
        return this.#selectDown(p, e);
      case 'wall': {
        if (double && this.#draft.length > 0) {
          this.#draft = [];
          this.#render();
          return true;
        }
        const q = this.#snapped(p, false).point;
        const last = this.#draft.at(-1);
        if (last) {
          const wall = this.#newWallProps();
          const r = addWall(this.plan, last, q, wall);
          if (r.id) {
            this.#selection = { kind: 'wall', id: r.id };
            this.#commit(r.plan);
          }
          // Closing a loop on its first point ends the chain.
          if (this.#draft[0] && dist(this.#draft[0], q) < 1e-6) {
            this.#draft = [];
            this.#render();
            return true;
          }
        }
        this.#draft.push(q);
        this.#render();
        return true;
      }
      case 'room': {
        const q = this.#snapped(p, true).point;
        const first = this.#draft[0];
        if (first && this.#draft.length >= 3 && dist(first, q) <= this.#snapRadius()) {
          this.#closeRoom();
        } else if (double && this.#draft.length >= 3) {
          this.#closeRoom();
        } else {
          this.#draft.push(q);
          this.#render();
        }
        return true;
      }
      case 'door':
      case 'window': {
        const hit = wallAt(this.plan, p, this.#snapRadius());
        if (!hit) return true;
        const r = addOpening(this.plan, this.#tool, hit.wall.id, hit.along, p);
        if (r.id) {
          this.#selection = { kind: this.#tool, id: r.id };
          this.#commit(r.plan);
        }
        return true;
      }
      case 'source': {
        const r = this.#placeSource(p);
        this.#selection = { kind: 'source', id: r.id };
        this.setTool('select');
        this.#commit(r.plan);
        return true;
      }
      case 'device': {
        const onMarker = (e.target as Element | null)?.closest('[data-kind=device]');
        if (onMarker) return this.#selectDown(p, e);
        if (!this.#armed) return false;
        this.#placeDevice(this.#armed, p);
        return true;
      }
      case 'measure': {
        const q = this.#snapped(p, true).point;
        if (this.#draft.length === 0 || this.#measured) {
          this.#measured = null;
          this.#draft = [q];
        } else {
          this.#measured = [this.#draft[0]!, q];
          this.#draft = [];
        }
        this.#render();
        return true;
      }
      case 'underlay':
        if (!this.plan.underlay) return false;
        this.#drag = { type: 'underlay', base: this.plan, start: p };
        this.#moved = false;
        return true;
    }
  }

  #selectDown(p: Point, e: PointerEvent): boolean {
    const target = e.target as Element | null;
    const handle = target?.closest<SVGElement>('[data-handle]');
    const base = this.plan;
    this.#moved = false;
    if (handle) {
      const [kind, id, index] = (handle.dataset['handle'] ?? '').split('|');
      if (kind === 'endpoint') {
        const wall = base.walls.find((w) => w.id === id);
        if (wall) this.#drag = { type: 'endpoint', base, from: index === 'a' ? wall.a : wall.b };
      } else if (kind === 'vertex' && id) {
        this.#drag = { type: 'vertex', base, id, index: Number(index) };
      }
      return true;
    }
    const el = target?.closest<SVGElement>('[data-kind]');
    const kind = el?.dataset['kind'] as Kind | undefined;
    const id = el?.dataset['id'];
    if (kind === 'device' && id) {
      const dev = base.devices?.find((x) => x.id === id);
      if (!dev) return false;
      this.#selection = { kind, id };
      this.#drag = { type: 'device', base, id, start: p, from: dev.position };
      this.#render();
      return true;
    }
    if (kind === 'source' && id) {
      const src = base.sources.find((x) => x.id === id);
      if (!src) return false;
      this.#selection = { kind, id };
      this.#drag = { type: 'source', base, id, start: p, from: src.position };
      this.#render();
      return true;
    }
    if (!kind || !id) {
      // A click beside a wall still picks it, so thin walls are easy to hit.
      const near = wallAt(base, p, this.#snapRadius() / 2);
      if (!near) {
        if (this.#selection) this.select(null);
        return false;
      }
      this.#selection = { kind: 'wall', id: near.wall.id };
      this.#drag = { type: 'wall', base, id: near.wall.id, start: p };
      this.#render();
      return true;
    }
    this.#selection = { kind, id };
    if (kind === 'wall') this.#drag = { type: 'wall', base, id, start: p };
    else if (kind === 'room') this.#drag = { type: 'room', base, id, start: p };
    else this.#drag = { type: 'opening', base, id };
    this.#render();
    return true;
  }

  #move(p: Point, e: PointerEvent): void {
    const d = this.#drag;
    if (!d) {
      this.#hoverAt(p, e);
      return;
    }
    const grid = (v: Point): Point => [
      mm(Math.round(v[0] / 0.05) * 0.05),
      mm(Math.round(v[1] / 0.05) * 0.05),
    ];
    let next: Plan;
    switch (d.type) {
      case 'endpoint': {
        const q = snap(p, {
          radius: this.#snapRadius(),
          grid: 0.05,
          targets: snapTargets(d.base, false),
          exclude: d.from,
        }).point;
        next = moveEndpoint(d.base, d.from, q);
        break;
      }
      case 'wall':
        next = moveWall(d.base, d.id, grid(sub(p, d.start)));
        break;
      case 'room':
        next = moveRoom(d.base, d.id, grid(sub(p, d.start)));
        break;
      case 'vertex': {
        const q = snap(p, {
          radius: this.#snapRadius(),
          grid: 0.05,
          targets: snapTargets(d.base, true),
          exclude: d.base.rooms.find((r) => r.id === d.id)?.polygon[d.index] ?? null,
        }).point;
        next = moveRoomVertex(d.base, d.id, d.index, q);
        break;
      }
      case 'opening': {
        const o = findOpening(d.base, d.id);
        const wall = o && d.base.walls.find((w) => w.id === o.wall);
        if (!wall) return;
        next = moveOpening(d.base, d.id, along(wall, p));
        break;
      }
      case 'source':
        next = moveSource(d.base, d.id, add(d.from, sub(p, d.start)));
        break;
      case 'device':
        next = moveDevice(d.base, d.id, add(d.from, sub(p, d.start)));
        break;
      case 'underlay': {
        const u = d.base.underlay;
        if (!u) return;
        const delta = sub(p, d.start);
        next = {
          ...d.base,
          underlay: { ...u, origin: [mm(u.origin[0] + delta[0]), mm(u.origin[1] + delta[1])] },
        };
        break;
      }
    }
    this.#moved = true;
    this.#preview = next;
    this.#render();
  }

  /** The plan being dragged, not yet committed. */
  #preview: Plan | null = null;

  #up(_p: Point, _e: PointerEvent): void {
    const preview = this.#preview;
    this.#drag = null;
    this.#preview = null;
    if (this.#moved && preview) this.#commit(preview);
    else this.#render();
    this.#moved = false;
  }

  #hoverAt(p: Point, _e: PointerEvent): void {
    if (this.#tool === 'wall' || this.#tool === 'room' || this.#tool === 'measure') {
      this.#hover = this.#snapped(p, this.#tool !== 'wall');
      this.#renderOverlay();
    } else if (this.#hover) {
      this.#hover = null;
      this.#renderOverlay();
    }
  }

  #closeRoom(): void {
    if (this.#draft.length < 3) return;
    const r = addRoom(this.plan, this.#draft);
    this.#draft = [];
    if (r.id) {
      this.#selection = { kind: 'room', id: r.id };
      this.setTool('select');
      this.#commit(r.plan);
    }
  }

  #newWallProps(): { thickness: number; material: string } {
    const sel = this.#selection;
    const wall = sel?.kind === 'wall' ? this.plan.walls.find((w) => w.id === sel.id) : undefined;
    return wall ? { thickness: wall.thickness, material: wall.material } : { ...DEFAULT_WALL };
  }

  #find(sel: Selection): unknown {
    const p = this.plan;
    if (sel.kind === 'wall') return p.walls.find((w) => w.id === sel.id);
    if (sel.kind === 'room') return p.rooms.find((r) => r.id === sel.id);
    if (sel.kind === 'source') return p.sources.find((x) => x.id === sel.id);
    if (sel.kind === 'device') return p.devices?.find((x) => x.id === sel.id);
    return findOpening(p, sel.id);
  }

  // ---- rendering ----

  #render(): void {
    this.#view.setPlan(this.#preview ?? this.plan, this.#selection);
    this.#view.setUnderlayUrl(this.#underlayUrl);
    this.#renderOverlay();
    if (!this.#drag) this.#renderInspector();
    this.#undoButton.disabled = !this.#history.canUndo;
    this.#redoButton.disabled = !this.#history.canRedo;
  }

  #renderOverlay(): void {
    const plan = this.#preview ?? this.plan;
    const k = this.#view.mpp;
    const r = 5 * k;
    const out: SVGElement[] = [];
    const sel = this.#selection;
    if (this.#tool === 'select' && sel?.kind === 'wall') {
      const wall = plan.walls.find((w) => w.id === sel.id);
      if (wall) {
        for (const end of ['a', 'b'] as const) {
          out.push(
            s('circle', {
              class: 'handle',
              'data-handle': `endpoint|${wall.id}|${end}`,
              cx: wall[end][0],
              cy: wall[end][1],
              r: r * 1.4,
            }),
          );
        }
      }
    }
    if (this.#tool === 'select' && sel?.kind === 'room') {
      const room = plan.rooms.find((x) => x.id === sel.id);
      room?.polygon.forEach((pt, i) =>
        out.push(
          s('circle', {
            class: 'handle',
            'data-handle': `vertex|${room.id}|${i}`,
            cx: pt[0],
            cy: pt[1],
            r,
          }),
        ),
      );
    }
    const hover = this.#hover?.point;
    const chain = [...this.#draft, ...(hover && this.#draft.length > 0 ? [hover] : [])];
    if (chain.length > 1) {
      const pts = chain.map((q) => q.join(',')).join(' ');
      out.push(
        s(this.#tool === 'room' ? 'polygon' : 'polyline', {
          class: `draft ${this.#tool}`,
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
    for (const q of this.#draft)
      out.push(s('circle', { class: 'draft-point', cx: q[0], cy: q[1], r }));
    if (this.#measured) {
      const [a, b] = this.#measured;
      out.push(s('line', { class: 'draft measure', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
      for (const q of this.#measured)
        out.push(s('circle', { class: 'draft-point', cx: q[0], cy: q[1], r }));
    }
    if (hover && this.#tool !== 'select') {
      out.push(
        s('circle', {
          class: this.#hover?.target ? 'cursor target' : 'cursor',
          cx: hover[0],
          cy: hover[1],
          r: r * 0.8,
        }),
      );
    }
    this.#view.overlay.replaceChildren(...out);
  }

  #renderInspector(): void {
    const plan = this.plan;
    const sel = this.#selection;
    const parts: (HTMLElement | null)[] = [this.#warningsPanel()];
    if (this.#tool === 'source' && !sel) parts.push(this.#newSourcePanel());
    if (this.#tool === 'device' && !sel) parts.push(this.#devicesPanel());
    if (this.#measured) parts.push(this.#measurePanel(this.#measured));
    if (sel?.kind === 'wall') parts.push(this.#wallPanel(sel.id));
    else if (sel?.kind === 'room') parts.push(this.#roomPanel(sel.id));
    else if (sel?.kind === 'door' || sel?.kind === 'window') parts.push(this.#openingPanel(sel.id));
    else if (sel?.kind === 'source') parts.push(this.#sourcePanel(sel.id));
    else if (sel?.kind === 'device') parts.push(this.#devicePanel(sel.id));
    else if (this.#tool !== 'device') parts.push(this.#planPanel());
    if (this.#tool === 'device' || sel?.kind === 'device') this.#deviceKey = this.#deviceListKey();
    if (!sel && this.#tool !== 'source' && this.#tool !== 'device')
      parts.push(this.#underlayPanel(), this.#materialsPanel());
    this.inspector.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
    this.inspector.dataset['selection'] = sel ? `${sel.kind}:${sel.id}` : '';
    this.inspector.dataset['walls'] = String(plan.walls.length);
  }

  #section(title: string, kind: string, ...children: (HTMLElement | null)[]): HTMLElement {
    return h('section', { 'data-panel': kind }, h('h2', {}, title), ...children);
  }

  #materialOptions(): { value: string; label: string }[] {
    return [...materialsOf(this.plan).values()].map((m) => ({ value: m.id, label: m.name }));
  }

  #wallPanel(id: string): HTMLElement | null {
    const wall = this.plan.walls.find((w) => w.id === id);
    if (!wall) return null;
    const length = frame(wall).length;
    return this.#section(
      'Wall',
      'wall',
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
          mm(wall.thickness * 100),
          (v) => this.#commit(updateWall(this.plan, id, { thickness: v / 100 })),
          { name: 'thickness', min: 1, max: 100, step: 0.5 },
        ),
      ),
      field(
        'Length (m)',
        numberInput(
          mm(length),
          (v) => {
            if (v <= 0.05) return;
            const { u } = frame(wall);
            this.#commit(moveEndpoint(this.plan, wall.b, add(wall.a, [u[0] * v, u[1] * v])));
          },
          { name: 'length', min: 0.05, step: 0.01 },
        ),
      ),
      h('p', { class: 'meta' }, `${wall.id}`),
      button('Delete wall', () => this.deleteSelection(), {
        class: 'danger',
        'data-action': 'delete',
      }),
    );
  }

  #openingPanel(id: string): HTMLElement | null {
    const o = findOpening(this.plan, id);
    if (!o) return null;
    const isDoor = 'hinge' in o;
    const set = (patch: Partial<Omit<Door, 'id' | 'wall'>>): void =>
      this.#commit(updateOpening(this.plan, id, patch));
    return this.#section(
      isDoor ? 'Door' : 'Window',
      isDoor ? 'door' : 'window',
      field(
        'Width (cm)',
        numberInput(mm(o.width * 100), (v) => set({ width: v / 100 }), {
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
        numberInput(mm(o.thickness * 100), (v) => set({ thickness: v / 100 }), {
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
      button(`Delete ${isDoor ? 'door' : 'window'}`, () => this.deleteSelection(), {
        class: 'danger',
        'data-action': 'delete',
      }),
    );
  }

  #roomPanel(id: string): HTMLElement | null {
    const room = this.plan.rooms.find((r) => r.id === id);
    if (!room) return null;
    const areas = areaChoices(this.#host.hass(), this.plan.floor_id ?? null);
    const area = polygonArea(room.polygon);
    let target = area;
    return this.#section(
      'Room',
      'room',
      field(
        'Name',
        textInput(
          room.name,
          (v) => v.trim() && this.#commit(updateRoom(this.plan, id, { name: v.trim() })),
          { name: 'name' },
        ),
      ),
      field(
        'Home Assistant area',
        select(
          [
            { value: '', label: '— none —' },
            ...areas.map((a) => ({ value: a.area_id, label: a.name })),
          ],
          room.area_id ?? '',
          (v) => {
            const linked = areas.find((a) => a.area_id === v);
            // Adopt the area's name while the room still has its default one.
            const rename = linked && /^Room \d+$/.test(room.name) ? { name: linked.name } : {};
            this.#commit(updateRoom(this.plan, id, { area_id: v || null, ...rename }));
          },
          { name: 'area' },
        ),
      ),
      h('p', { class: 'meta', 'data-area': area.toFixed(2) }, `${area.toFixed(2)} m² drawn`),
      h(
        'div',
        { class: 'calibrate' },
        field(
          'Real area (m²)',
          numberInput(mm(area), (v) => (target = v), { name: 'real-area', min: 0.1, step: 0.1 }),
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
      button('Delete room', () => this.deleteSelection(), {
        class: 'danger',
        'data-action': 'delete',
      }),
    );
  }

  #measurePanel([a, b]: [Point, Point]): HTMLElement {
    const d = dist(a, b);
    let target = d;
    return this.#section(
      'Measure',
      'measure',
      h('p', { class: 'meta', 'data-distance': d.toFixed(3) }, `${d.toFixed(2)} m drawn`),
      field(
        'Real distance (m)',
        numberInput(mm(d), (v) => (target = v), { name: 'real-distance', min: 0.01, step: 0.01 }),
      ),
      button(
        'Scale plan to match',
        () => {
          if (!(target > 0) || d === 0) return;
          this.#measured = null;
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
  #placeSource(p: Point): { plan: Plan; id: string } {
    const kind = this.#sourceKind;
    const plan = this.plan;
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

  #sourcePanel(id: string): HTMLElement | null {
    const src = this.plan.sources.find((x) => x.id === id);
    if (!src) return null;
    const hass = this.#host.hass();
    const floor = this.plan.floor_id ?? null;
    const set = (patch: Parameters<typeof updateSource>[2]): void =>
      this.#commit(updateSource(this.plan, id, patch));
    const pick = (v: string): void => {
      const entity = v.trim();
      set({ entity_id: entity, area_id: entity ? entityArea(hass, entity) : null });
    };
    const choices = sourceChoices(hass, src.kind, floor);
    const areaName = src.area_id ? (hass?.areas?.[src.area_id]?.name ?? src.area_id) : null;
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
    return this.#section(
      'Source',
      'source',
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
        `${areaName ? `In ${areaName}` : 'No area'} · ${src.position[0].toFixed(2)}, ${src.position[1].toFixed(2)} m`,
      ),
      button('Delete source', () => this.deleteSelection(), {
        class: 'danger',
        'data-action': 'delete',
      }),
    );
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
    return `${placed}|${choices}|${this.#armed}`;
  }

  #placeDevice(entity: string, p: Point): void {
    const r = addDevice(this.plan, entity, p);
    this.#armed = null;
    this.#note = '';
    this.#selection = { kind: 'device', id: r.id };
    this.#commit(r.plan);
  }

  #autoPlace(): void {
    const spots = autoPlace(this.plan, this.#deviceChoices());
    let plan = this.plan;
    for (const s of spots) plan = addDevice(plan, s.entity_id, s.position).plan;
    this.#note =
      spots.length > 0
        ? `Placed ${spots.length} device${spots.length === 1 ? '' : 's'} in their rooms. Drag them where they really are.`
        : 'Nothing to place: link rooms to areas first, or every device in them is on the plan.';
    if (spots.length > 0) this.#commit(plan);
    else this.#renderInspector();
  }

  #devicesPanel(): HTMLElement {
    const hass = this.#host.hass();
    const placed = new Set((this.plan.devices ?? []).map((d) => d.entity_id));
    const free = this.#deviceChoices().filter((c) => !placed.has(c.entity_id));
    const areaName = (a: string | null): string => (a ? (hass?.areas?.[a]?.name ?? a) : 'No area');
    const list = h('ul', { class: 'entities', 'aria-label': 'Entities not on the plan' });
    for (const c of free) {
      const item = h(
        'li',
        {
          draggable: 'true',
          'data-entity': c.entity_id,
          'aria-pressed': String(this.#armed === c.entity_id),
          role: 'button',
          tabindex: 0,
          title: `${c.entity_id} — drag onto the plan, or click and then click the plan`,
        },
        h('span', { class: 'name' }, c.name),
        h('span', { class: 'meta' }, areaName(c.area_id)),
      );
      const arm = (): void => {
        this.#armed = this.#armed === c.entity_id ? null : c.entity_id;
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

  #devicePanel(id: string): HTMLElement | null {
    const dev = this.plan.devices?.find((d) => d.id === id);
    if (!dev) return null;
    const hass = this.#host.hass();
    const placed = new Set((this.plan.devices ?? []).map((d) => d.entity_id));
    const opts = this.#deviceChoices()
      .filter((c) => c.entity_id === dev.entity_id || !placed.has(c.entity_id))
      .map((c) => ({ value: c.entity_id, label: c.name }));
    if (!opts.some((o) => o.value === dev.entity_id))
      opts.unshift({ value: dev.entity_id, label: `${dev.entity_id} (not on this floor)` });
    const area = hass ? entityArea(hass, dev.entity_id) : null;
    const look = deviceLook(dev.entity_id, hass?.states?.[dev.entity_id]);
    return this.#section(
      'Device',
      'device',
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
      button('Delete device', () => this.deleteSelection(), {
        class: 'danger',
        'data-action': 'delete',
      }),
    );
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
      const { underlay, blobUrl } = await importUnderlay(hass, this.#host.planId, file, this.plan);
      this.#setUnderlayUrl(blobUrl);
      this.#commit({ ...this.plan, underlay });
      this.#view.fit();
    } catch (err) {
      this.#setSaveState(`Import failed: ${(err as Error).message ?? err}`, true);
    }
  }

  async #loadUnderlay(): Promise<void> {
    const u = this.plan.underlay;
    if (!u || this.#underlayUrl) return;
    try {
      this.#setUnderlayUrl(await loadUnderlayUrl(this.#host.hass(), u.url));
    } catch {
      // The plan still works without its picture.
    }
  }

  #setUnderlayUrl(url: string): void {
    // The view revokes the old blob URL when it gets the new one.
    this.#underlayUrl = url;
    this.#render();
  }
}

function findOpening(plan: Plan, id: string): Opening | undefined {
  return plan.doors.find((d) => d.id === id) ?? plan.windows.find((w) => w.id === id);
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
