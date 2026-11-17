// The editor's interfaces: selection, tool state and input, snapping and autosave.
import type { Device, Door, Plan, Room, Source, Wall } from '../plan/models';
import type { Point, Window } from '../plan/types';
import type { Drag, Kind, Tool } from './types';

/** The kinds of plan item the editor selects, each with its type. */
export interface Items {
  wall: Wall;
  room: Room;
  door: Door;
  window: Window;
  source: Source;
  device: Device;
}

export interface Selection {
  readonly kind: Kind;
  readonly id: string;
}

export interface Click {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

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
  /** The device the Device tool places on the next click, by the entity its marker shows. */
  readonly armed: string | null;
}

export interface ToolContext {
  readonly plan: Plan;
  /** Snap radius in metres. */
  readonly radius: number;
  /** `plan` with a new source at `p`. */
  addSource(plan: Plan, p: Point): { plan: Plan; id: string };
  /** The Home Assistant device of an entity, or null when it has none. */
  deviceOf(entity: string): string | null;
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

export interface SnapOptions {
  /** Snap radius in metres (the editor converts from screen pixels). */
  radius: number;
  grid: number;
  /** Previous point: lock to horizontal/vertical when nearly so. */
  anchor?: Point | null;
  targets: readonly Point[];
  /** Ignore targets at these points (the endpoint being dragged). */
  exclude?: Point | null;
}

export interface Autosaver<T> {
  /** `value` changed: save it once no other change follows within the delay. */
  schedule(value: T): void;
  /** Save now if anything changed since the last save. */
  flush(): Promise<void>;
  /** Try a failed save again now instead of after its wait (e.g. the connection is back). */
  retry(): void;
  /** Drop a pending save and stop retrying (`flush` first to keep it). */
  dispose(): void;
  /**
   * A change is not stored yet: waiting for the delay, being saved, or its save failed (and may be
   * waiting to retry).
   */
  readonly unsaved: boolean;
}
