import { describe, expect, it } from 'vite-plus/test';
import { DOUBLE_CLICK_MS, DOUBLE_CLICK_PX } from '../src/editor/constants';
import type { Pointer, ToolContext, ToolState } from '../src/editor/models';
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
} from '../src/editor/tools';
import type { Tool } from '../src/editor/types';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import type { Point } from '../src/plan/types';
import { addDevice, addRoom, addSource, addWall } from '../src/plan/ops';

/** Snap radius used throughout, in metres. */
const RADIUS = 0.1;

const ctx = (plan: Plan): ToolContext => ({
  plan,
  radius: RADIUS,
  addSource: (p, at) => addSource(p, 'sensor', at, 'sensor.t'),
});

/** A 4 x 3 m box of 20 cm exterior walls. */
function box(): Plan {
  const corners: Point[] = [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ];
  let plan = emptyPlan('Box');
  for (let i = 0; i < 4; i++)
    plan = addWall(plan, corners[i]!, corners[(i + 1) % 4]!, {
      material: 'exterior',
      thickness: 0.2,
    }).plan;
  return plan;
}

/** Press at each point in turn, committing like the editor does; `last` adds to the final press. */
function press(
  s: ToolState,
  plan: Plan,
  points: Point[],
  last: Partial<Pointer> = {},
): { s: ToolState; plan: Plan; pass?: boolean } {
  let pass: boolean | undefined;
  points.forEach((p, i) => {
    const r = down(s, ctx(plan), { p, ...(i === points.length - 1 ? last : {}) });
    s = r.state;
    plan = r.commit ?? plan;
    pass = r.pass;
  });
  return { s, plan, pass };
}

/** Drag from the state's press to `p` and release. */
function drag(s: ToolState, plan: Plan, p: Point): { s: ToolState; plan: Plan } {
  const r = up(move(s, ctx(plan), p));
  return { s: r.state, plan: r.commit ?? plan };
}

const tool = (t: Tool): ToolState => withTool(initialState, t);

describe('isDoubleClick', () => {
  const at = { t: 1000, x: 10, y: 10 };
  it('needs a quick second click in the same spot', () => {
    expect(isDoubleClick(at, { t: 1000 + DOUBLE_CLICK_MS - 1, x: 12, y: 12 })).toBe(true);
    expect(isDoubleClick(at, { t: 1000 + DOUBLE_CLICK_MS, x: 10, y: 10 })).toBe(false);
    expect(isDoubleClick(at, { t: 1001, x: 10 + DOUBLE_CLICK_PX, y: 10 })).toBe(false);
  });
});

describe('wall tool', () => {
  it('chains walls corner to corner, selecting the newest', () => {
    const { s, plan } = press(tool('wall'), emptyPlan('P'), [
      [0, 0],
      [4, 0],
      [4, 3],
    ]);
    expect(plan.walls.map((w) => [w.a, w.b])).toEqual([
      [
        [0, 0],
        [4, 0],
      ],
      [
        [4, 0],
        [4, 3],
      ],
    ]);
    expect(s.draft).toHaveLength(3);
    expect(s.selection).toEqual({ kind: 'wall', id: 'wall_2' });
  });

  it('ends the chain on a double click or on its first point', () => {
    const start = press(tool('wall'), emptyPlan('P'), [
      [0, 0],
      [4, 0],
    ]);
    const ended = down(start.s, ctx(start.plan), { p: [4, 0], double: true });
    expect(ended.state.draft).toEqual([]);
    expect(ended.commit).toBeUndefined();

    const loop = press(start.s, start.plan, [
      [4, 3],
      [0.04, 0.03],
    ]);
    expect(loop.plan.walls).toHaveLength(3);
    expect(loop.plan.walls[2]!.b).toEqual([0, 0]);
    expect(loop.s.draft).toEqual([]);
  });

  it('snaps to the grid, straightens near an axis and snaps to wall ends', () => {
    const s = press(tool('wall'), box(), [[1.02, 1.01]]).s;
    expect(s.draft).toEqual([[1, 1]]);
    expect(move(s, ctx(box()), [3, 1.12]).hover).toEqual({ point: [3, 1], target: false });
    expect(move(s, ctx(box()), [3.95, 2.96]).hover).toEqual({ point: [4, 3], target: true });
  });

  it('gives a new wall the selected wall’s thickness and material', () => {
    const s = { ...tool('wall'), selection: { kind: 'wall' as const, id: 'wall_1' } };
    const { plan } = press(s, box(), [
      [1, 1],
      [2, 1],
    ]);
    expect(plan.walls[4]).toMatchObject({ thickness: 0.2, material: 'exterior' });
  });
});

describe('room tool', () => {
  const corners: Point[] = [
    [0, 0],
    [4, 0],
    [4, 3],
  ];

  it('closes on a click near the first corner and selects the room', () => {
    const { s, plan } = press(tool('room'), emptyPlan('P'), [...corners, [0.05, 0.02]]);
    expect(plan.rooms[0]!.polygon).toEqual(corners);
    expect(s).toMatchObject({
      tool: 'select',
      draft: [],
      selection: { kind: 'room', id: 'room_1' },
    });
  });

  it('closes on a double click', () => {
    const { plan } = press(tool('room'), emptyPlan('P'), [...corners, [0, 3]], { double: true });
    expect(plan.rooms[0]!.polygon).toHaveLength(3);
  });

  it('closes on Enter only with three corners', () => {
    const two = press(tool('room'), emptyPlan('P'), corners.slice(0, 2));
    expect(closeRoom(two.s, two.plan)).toEqual({ state: two.s });
    const three = press(tool('room'), emptyPlan('P'), corners);
    expect(closeRoom(three.s, three.plan).commit?.rooms).toHaveLength(1);
  });
});

describe('door and window tools', () => {
  it('put an opening on the wall clicked, and nothing off a wall', () => {
    const { s, plan } = press(tool('door'), box(), [[2, 0.05]]);
    expect(plan.doors).toHaveLength(1);
    expect(s.selection).toEqual({ kind: 'door', id: 'door_1' });

    const off = down(tool('window'), ctx(box()), { p: [2, 1.5] });
    expect(off.commit).toBeUndefined();
    expect(off.state).toEqual(tool('window'));
  });
});

describe('source tool', () => {
  it('places a source and goes back to Select with it selected', () => {
    const { s, plan } = press(tool('source'), box(), [[1, 1]]);
    expect(plan.sources[0]).toMatchObject({ entity_id: 'sensor.t', position: [1, 1] });
    expect(s).toMatchObject({ tool: 'select', selection: { kind: 'source' } });
  });
});

describe('device tool', () => {
  it('passes a press with nothing armed, so the view pans', () => {
    const r = down(tool('device'), ctx(box()), { p: [1, 1] });
    expect(r.pass).toBe(true);
    expect(r.commit).toBeUndefined();
  });

  it('places the armed entity once', () => {
    const { s, plan } = press({ ...tool('device'), armed: 'light.a' }, box(), [[1, 1]]);
    expect(plan.devices).toEqual([{ id: 'device_1', entity_id: 'light.a', position: [1, 1] }]);
    expect(s).toMatchObject({ armed: null, selection: { kind: 'device', id: 'device_1' } });
  });

  it('places a dropped entity', () => {
    const r = placeDevice(tool('device'), box(), 'light.b', [2, 2]);
    expect(r.commit?.devices?.[0]).toMatchObject({ entity_id: 'light.b', position: [2, 2] });
  });

  it('drags a placed device', () => {
    const plan = addDevice(box(), 'light.a', [1, 1]).plan;
    const hit = { kind: 'device' as const, id: 'device_1' };
    const pressed = press(tool('device'), plan, [[1, 1]], { hit });
    expect(pressed.s.selection).toEqual(hit);
    expect(drag(pressed.s, plan, [1.5, 1.25]).plan.devices![0]!.position).toEqual([1.5, 1.25]);
  });
});

describe('measure tool', () => {
  it('measures between two clicks, then starts over', () => {
    const two = press(tool('measure'), box(), [
      [1, 1],
      [2, 1],
    ]);
    expect(two.s).toMatchObject({
      draft: [],
      measured: [
        [1, 1],
        [2, 1],
      ],
    });
    expect(two.plan).toEqual(box());
    const again = press(two.s, box(), [[3, 1]]).s;
    expect(again).toMatchObject({ draft: [[3, 1]], measured: null });
  });
});

describe('select tool', () => {
  const room = (): Plan =>
    addRoom(emptyPlan('P'), [
      [0, 0],
      [4, 0],
      [4, 3],
    ]).plan;
  const hit = { kind: 'room' as const, id: 'room_1' };

  it('previews a drag and commits it on release, moving on the grid', () => {
    const pressed = press(tool('select'), room(), [[1, 1]], { hit });
    expect(pressed.s).toMatchObject({ selection: hit, drag: { type: 'item' } });
    const moving = move(pressed.s, ctx(room()), [2.02, 1.01]);
    expect(moving.preview!.rooms[0]!.polygon[0]).toEqual([1, 0]);
    const r = up(moving);
    expect(r.commit).toBe(moving.preview);
    expect(r.state).toMatchObject({ drag: null, preview: null });
  });

  it('commits nothing for a press without a move', () => {
    const pressed = press(tool('select'), room(), [[1, 1]], { hit });
    expect(up(pressed.s).commit).toBeUndefined();
  });

  it('picks a wall from a click just beside it', () => {
    const { s } = press(tool('select'), box(), [[2, 0.14]]);
    expect(s.selection).toEqual({ kind: 'wall', id: 'wall_1' });
  });

  it('drops the selection and passes on empty space', () => {
    const selected = { ...tool('select'), selection: hit };
    const r = down(selected, ctx(room()), { p: [2, 2] });
    expect(r).toEqual({ state: { ...selected, selection: null }, pass: true });
  });

  it('drags a wall end, keeping joined walls joined and snapping to other ends', () => {
    const plan = addWall(box(), [1, 1], [2, 1]).plan;
    const pressed = press(tool('select'), plan, [[2, 1]], { handle: 'endpoint|wall_5|b' });
    expect(drag(pressed.s, plan, [3.96, 2.97]).plan.walls[4]!.b).toEqual([4, 3]);
    const corner = press(tool('select'), box(), [[4, 0]], { handle: 'endpoint|wall_1|b' });
    const moved = drag(corner.s, box(), [4.52, 0.01]).plan;
    expect(moved.walls[0]!.b).toEqual([4.5, 0]);
    expect(moved.walls[1]!.a).toEqual([4.5, 0]);
  });

  it('drags a room corner', () => {
    const pressed = press(tool('select'), room(), [[4, 3]], { handle: 'vertex|room_1|2' });
    expect(drag(pressed.s, room(), [5.01, 3.02]).plan.rooms[0]!.polygon[2]).toEqual([5, 3]);
  });
});

describe('underlay tool', () => {
  const traced = (): Plan => ({
    ...box(),
    underlay: { url: '/x', width_px: 100, height_px: 50, scale: 0.05, origin: [1, 1], opacity: 1 },
  });

  it('drags the underlay', () => {
    const pressed = press(tool('underlay'), traced(), [[2, 2]]);
    expect(drag(pressed.s, traced(), [2.5, 1.75]).plan.underlay!.origin).toEqual([1.5, 0.75]);
  });

  it('passes without an underlay', () => {
    expect(down(tool('underlay'), ctx(box()), { p: [2, 2] }).pass).toBe(true);
  });
});

describe('hover', () => {
  it('shows the snapped cursor only while drawing', () => {
    const drawing = move(tool('room'), ctx(box()), [1.01, 1.02]);
    expect(drawing.hover).toEqual({ point: [1, 1], target: false });
    const selecting = withTool(drawing, 'select');
    const cleared = move(selecting, ctx(box()), [1, 1]);
    expect(cleared.hover).toBeNull();
    expect(move(cleared, ctx(box()), [2, 2])).toBe(cleared);
  });
});

describe('tool changes', () => {
  it('drop the drawing, and the selection for tools that place things', () => {
    const sel = { kind: 'wall' as const, id: 'wall_1' };
    const s: ToolState = { ...tool('wall'), draft: [[0, 0]], selection: sel, armed: 'light.a' };
    expect(withTool(s, 'room')).toMatchObject({ draft: [], selection: sel, armed: null });
    expect(withTool(s, 'source').selection).toBeNull();
    expect(withTool({ ...s, tool: 'device' }, 'device').armed).toBe('light.a');
  });

  it('Esc drops the drawing, then the tool, then the selection', () => {
    const sel = { kind: 'wall' as const, id: 'wall_1' };
    const drawing: ToolState = { ...tool('wall'), draft: [[0, 0]], selection: sel };
    const s1 = escape(drawing);
    expect(s1).toMatchObject({ tool: 'wall', draft: [], selection: sel });
    const s2 = escape(s1);
    expect(s2).toMatchObject({ tool: 'select', selection: sel });
    expect(escape(s2).selection).toBeNull();
  });
});
