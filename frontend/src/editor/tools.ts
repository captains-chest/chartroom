// The editor's tools as pure steps: (state, pointer input) → the next state, plus the plan change
// to commit. plan-editor.ts turns DOM events into inputs, commits through History and renders.
import { add, dist, mmPoint, sub } from '../geometry';
import type { Plan, Point, Wall } from '../plan';
import {
  addDevice,
  addOpening,
  addRoom,
  addWall,
  moveEndpoint,
  moveRoomVertex,
  snap,
  snapTargets,
  wallAt,
} from '../plan-ops';
import { findItem, GRID, type Item, type Kind, kindOps, type Selection } from './kinds';

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

/** Two clicks within this many milliseconds and screen pixels are a double click. */
export const DOUBLE_CLICK_MS = 350;
export const DOUBLE_CLICK_PX = 6;

export interface Click {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

/** Two quick clicks in the same spot (quick clicks elsewhere are new points). */
export const isDoubleClick = (prev: Click, next: Click): boolean =>
  next.t - prev.t < DOUBLE_CLICK_MS &&
  Math.hypot(next.x - prev.x, next.y - prev.y) < DOUBLE_CLICK_PX;

export type Drag =
  | {
      readonly type: 'item';
      readonly base: Plan;
      readonly kind: Kind;
      readonly item: Item;
      readonly start: Point;
    }
  | { readonly type: 'endpoint'; readonly base: Plan; readonly from: Point }
  | { readonly type: 'vertex'; readonly base: Plan; readonly id: string; readonly index: number }
  | { readonly type: 'underlay'; readonly base: Plan; readonly start: Point };

export interface Snapped {
  readonly point: Point;
  /** Snapped to a wall end or face rather than the grid. */
  readonly target: boolean;
}

export interface ToolState {
  readonly tool: Tool;
  readonly selection: Selection | null;
  /** Points placed so far by the wall, room or measure tool. */
  readonly draft: readonly Point[];
  readonly measured: readonly [Point, Point] | null;
  /** The snapped point under the pointer while drawing. */
  readonly hover: Snapped | null;
  readonly drag: Drag | null;
  /** The plan being dragged, not yet committed. */
  readonly preview: Plan | null;
  /** The entity the Device tool places on the next click. */
  readonly armed: string | null;
}

export interface ToolContext {
  readonly plan: Plan;
  /** Snap radius in metres. */
  readonly radius: number;
  /** `plan` with a new source at `p`. */
  addSource(plan: Plan, p: Point): { plan: Plan; id: string };
}

/** A press on the plan. */
export interface Pointer {
  readonly p: Point;
  readonly double?: boolean;
  /** The `data-handle` pressed: `endpoint|<wall>|a|b` or `vertex|<room>|<index>`. */
  readonly handle?: string;
  /** The item pressed. */
  readonly hit?: Selection | null;
}

export interface ToolResult {
  readonly state: ToolState;
  /** The plan change to commit. */
  readonly commit?: Plan;
  /** The press was not for the tool (the view pans instead). */
  readonly pass?: boolean;
}

export const initialState: ToolState = {
  tool: 'select',
  selection: null,
  draft: [],
  measured: null,
  hover: null,
  drag: null,
  preview: null,
  armed: null,
};

export const withTool = (s: ToolState, tool: Tool): ToolState => ({
  ...s,
  tool,
  draft: [],
  measured: null,
  selection: tool === 'underlay' || tool === 'source' || tool === 'device' ? null : s.selection,
  armed: tool === 'device' ? s.armed : null,
});

/** Esc: drop the drawing, else go back to Select, else drop the selection. */
export const escape = (s: ToolState): ToolState =>
  s.draft.length > 0 || s.measured
    ? { ...s, draft: [], measured: null }
    : s.tool === 'select'
      ? { ...s, selection: null }
      : withTool(s, 'select');

const snapped = (
  s: ToolState,
  plan: Plan,
  radius: number,
  p: Point,
  faces: boolean,
  exclude: Point | null = null,
): Snapped =>
  snap(p, {
    radius,
    grid: GRID,
    anchor: s.draft.at(-1) ?? null,
    targets: snapTargets(plan, faces),
    exclude,
  });

/** Make the drafted corners a room (Enter, a double click or a click on the first corner). */
export function closeRoom(s: ToolState, plan: Plan): ToolResult {
  if (s.draft.length < 3) return { state: s };
  const r = addRoom(plan, s.draft);
  return r.id
    ? { state: { ...withTool(s, 'select'), selection: { kind: 'room', id: r.id } }, commit: r.plan }
    : { state: { ...s, draft: [] } };
}

export const placeDevice = (s: ToolState, plan: Plan, entity: string, p: Point): ToolResult => {
  const r = addDevice(plan, entity, p);
  return { state: { ...s, armed: null, selection: { kind: 'device', id: r.id } }, commit: r.plan };
};

/** The selected wall, whose thickness and material a new wall takes. */
const selectedWall = ({ selection: sel }: ToolState, plan: Plan): Wall | undefined =>
  sel?.kind === 'wall' ? plan.walls.find((w) => w.id === sel.id) : undefined;

function selectDown(s: ToolState, ctx: ToolContext, ptr: Pointer): ToolResult {
  const { plan } = ctx;
  if (ptr.handle) {
    const [kind, id = '', index] = ptr.handle.split('|');
    const wall = plan.walls.find((w) => w.id === id);
    const drag: Drag | undefined =
      kind === 'vertex'
        ? { type: 'vertex', base: plan, id, index: Number(index) }
        : wall && { type: 'endpoint', base: plan, from: wall[index as 'a' | 'b'] };
    return { state: drag ? { ...s, drag } : s };
  }
  // A click beside a wall still picks it, so thin walls are easy to hit.
  const near = ptr.hit ? null : wallAt(plan, ptr.p, ctx.radius / 2);
  const sel = ptr.hit ?? (near && { kind: 'wall', id: near.wall.id });
  if (!sel) return { state: s.selection ? { ...s, selection: null } : s, pass: true };
  const item = findItem(plan, sel);
  if (!item) return { state: s, pass: true };
  const drag: Drag = { type: 'item', base: plan, kind: sel.kind, item, start: ptr.p };
  return { state: { ...s, selection: sel, drag } };
}

export function down(s: ToolState, ctx: ToolContext, ptr: Pointer): ToolResult {
  const { plan, radius } = ctx;
  const { p, double } = ptr;
  const { tool, draft } = s;
  switch (tool) {
    case 'select':
      return selectDown(s, ctx, ptr);
    case 'wall': {
      if (double && draft.length > 0) return { state: { ...s, draft: [] } };
      const q = snapped(s, plan, radius, p, false).point;
      const last = draft.at(-1);
      const r = last && addWall(plan, last, q, selectedWall(s, plan));
      // Closing a loop on its first point ends the chain.
      const closed = last && dist(draft[0]!, q) < 1e-6;
      const selection: Selection | null = r?.id ? { kind: 'wall', id: r.id } : s.selection;
      return { state: { ...s, selection, draft: closed ? [] : [...draft, q] }, commit: r?.plan };
    }
    case 'room': {
      const q = snapped(s, plan, radius, p, true).point;
      if (draft.length >= 3 && (double || dist(draft[0]!, q) <= radius)) return closeRoom(s, plan);
      return { state: { ...s, draft: [...draft, q] } };
    }
    case 'door':
    case 'window': {
      const hit = wallAt(plan, p, radius);
      const r = hit && addOpening(plan, tool, hit.wall.id, hit.along, p);
      // A failed add leaves the plan as it was, which commits nothing.
      return { state: r?.id ? { ...s, selection: { kind: tool, id: r.id } } : s, commit: r?.plan };
    }
    case 'source': {
      const r = ctx.addSource(plan, p);
      return {
        state: { ...withTool(s, 'select'), selection: { kind: 'source', id: r.id } },
        commit: r.plan,
      };
    }
    case 'device':
      if (ptr.hit?.kind === 'device') return selectDown(s, ctx, ptr);
      return s.armed ? placeDevice(s, plan, s.armed, p) : { state: s, pass: true };
    case 'measure': {
      const q = snapped(s, plan, radius, p, true).point;
      const state: ToolState =
        draft.length === 0 || s.measured
          ? { ...s, measured: null, draft: [q] }
          : { ...s, measured: [draft[0]!, q], draft: [] };
      return { state };
    }
    case 'underlay':
      return plan.underlay
        ? { state: { ...s, drag: { type: 'underlay', base: plan, start: p } } }
        : { state: s, pass: true };
  }
}

/**
 * The pointer moved to `p`: drag there (the dragged plan becomes the preview), or else snap the
 * drawing cursor (the same state when neither changes anything).
 */
export function move(s: ToolState, ctx: ToolContext, p: Point): ToolState {
  const { drag: d, tool: t } = s;
  if (!d) {
    if (t === 'wall' || t === 'room' || t === 'measure')
      return { ...s, hover: snapped(s, ctx.plan, ctx.radius, p, t !== 'wall') };
    return s.hover ? { ...s, hover: null } : s;
  }
  const { base } = d;
  let next: Plan | undefined;
  switch (d.type) {
    case 'item':
      next = kindOps(d.kind).drag(base, d.item, sub(p, d.start), p);
      break;
    case 'endpoint':
      next = moveEndpoint(base, d.from, snapped(s, base, ctx.radius, p, false, d.from).point);
      break;
    case 'vertex': {
      const old = base.rooms.find((r) => r.id === d.id)?.polygon[d.index] ?? null;
      const q = snapped(s, base, ctx.radius, p, true, old).point;
      next = moveRoomVertex(base, d.id, d.index, q);
      break;
    }
    case 'underlay': {
      const u = base.underlay;
      if (u)
        next = { ...base, underlay: { ...u, origin: mmPoint(add(u.origin, sub(p, d.start))) } };
    }
  }
  return next ? { ...s, preview: next } : s;
}

/** Release: commit what was dragged. */
export const up = (s: ToolState): ToolResult => ({
  state: { ...s, drag: null, preview: null },
  commit: s.preview ?? undefined,
});
