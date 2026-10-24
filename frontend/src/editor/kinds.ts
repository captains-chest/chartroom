// The kinds of plan item the editor selects, with how to find, delete and drag each. Adding a kind
// is an entry in Items (models.ts), one here and its inspector panel in plan-editor.ts.
import { add, along } from '../geometry';
import type { Door, Plan } from '../plan/models';
import type { Point, Window } from '../plan/types';
import {
  deleteDevice,
  deleteOpening,
  deleteRoom,
  deleteSource,
  deleteWall,
  moveDevice,
  moveOpening,
  moveRoom,
  moveSource,
  moveWall,
} from '../plan/ops';
import { GRID } from './constants';
import type { Items, Selection } from './models';
import { snap } from './snap';
import type { Item, Kind } from './types';

interface KindOps<T extends { id: string }> {
  list(plan: Plan): readonly T[];
  remove(plan: Plan, id: string): Plan;
  /** `base` with `item` dragged by `delta` to `p`, or nothing when it cannot move. */
  drag(base: Plan, item: T, delta: Point, p: Point): Plan | undefined;
}

/** A tool's or kind's name for the UI: `wall` is "Wall". */
export const titleOf = (name: string): string => name[0]!.toUpperCase() + name.slice(1);

const onGrid = (v: Point): Point => snap(v, { radius: 0, grid: GRID, targets: [] }).point;

const opening = {
  remove: deleteOpening,
  drag: (base: Plan, o: Door | Window, _delta: Point, p: Point) => {
    const wall = base.walls.find((w) => w.id === o.wall);
    return wall && moveOpening(base, o.id, along(wall, p));
  },
};

export const KINDS: { readonly [K in Kind]: KindOps<Items[K]> } = {
  wall: {
    list: (p) => p.walls,
    remove: deleteWall,
    drag: (base, w, delta) => moveWall(base, w.id, onGrid(delta)),
  },
  room: {
    list: (p) => p.rooms,
    remove: deleteRoom,
    drag: (base, r, delta) => moveRoom(base, r.id, onGrid(delta)),
  },
  door: { list: (p) => p.doors, ...opening },
  window: { list: (p) => p.windows, ...opening },
  source: {
    list: (p) => p.sources,
    remove: deleteSource,
    drag: (base, s, delta) => moveSource(base, s.id, add(s.position, delta)),
  },
  device: {
    list: (p) => p.devices ?? [],
    remove: deleteDevice,
    drag: (base, d, delta) => moveDevice(base, d.id, add(d.position, delta)),
  },
};

/** The operations of `kind`, for code that handles every kind alike. */
export const kindOps = (kind: Kind): KindOps<Item> => KINDS[kind];

export const findItem = (plan: Plan, sel: Selection): Item | undefined =>
  kindOps(sel.kind)
    .list(plan)
    .find((x) => x.id === sel.id);
