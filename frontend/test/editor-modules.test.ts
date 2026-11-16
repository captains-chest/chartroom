// The editor's parts that need no editor: the overlay, plan file actions and an inspector panel.
import { describe, expect, it, vi } from 'vite-plus/test';
import { exportFiles, readImport } from '../src/editor/file-actions';
import { overlayNodes } from '../src/editor/overlay';
import type { PanelContext } from '../src/editor/panels/context';
import { itemPanel } from '../src/editor/panels/item';
import { initialState } from '../src/editor/tools';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { planFileJson } from '../src/plan-file';
import { underlayPath } from '../src/underlay-url';
import { type FakeElement, installFakeDom } from './fake-dom';

installFakeDom();

const wallPlan = (): Plan => ({
  ...emptyPlan('Home'),
  walls: [{ id: 'w', a: [0, 0], b: [4, 0], thickness: 0.1, material: 'exterior' }],
});

const all = (el: FakeElement): FakeElement[] => [
  el,
  ...el.children.flatMap((c) => (typeof c === 'string' ? [] : all(c))),
];

describe('editor overlay', () => {
  it("draws the selected wall's end handles, sized for the zoom", () => {
    const nodes = overlayNodes(
      { ...initialState, selection: { kind: 'wall', id: 'w' } },
      wallPlan(),
      0.01,
    ) as unknown as FakeElement[];
    expect(nodes.map((n) => n.getAttribute('data-handle'))).toEqual([
      'endpoint|w|a',
      'endpoint|w|b',
    ]);
    expect(Number(nodes[0]!.getAttribute('r'))).toBeCloseTo(0.07);
  });

  it('draws a wall being drawn with its length, and the cursor', () => {
    const nodes = overlayNodes(
      { ...initialState, tool: 'wall', draft: [[0, 0]], hover: { point: [3, 4], target: false } },
      emptyPlan('Home'),
      0.01,
    ) as unknown as FakeElement[];
    const label = nodes.find((n) => n.getAttribute('class') === 'measure-label');
    expect(label?.children).toEqual(['5.00 m']);
    expect(nodes.at(-1)!.getAttribute('class')).toBe('cursor');
  });
});

describe('plan file actions', () => {
  const image = new Blob(['<svg/>'], { type: 'image/svg+xml' });

  it('exports the plan alone, with the image embedded, or with the image as its own file', async () => {
    const plan = wallPlan();
    const alone = await exportFiles(plan, 'home', image, 'none');
    expect(alone.map((f) => f.name)).toEqual(['chartroom-home.json']);
    const embedded = await exportFiles({ ...plan, underlay: null }, 'home', image, 'embed');
    expect(embedded).toHaveLength(1);
    const withFile = await exportFiles(
      {
        ...plan,
        underlay: {
          url: underlayPath('home'),
          width_px: 1,
          height_px: 1,
          scale: 1,
          origin: [0, 0],
          opacity: 1,
        },
      },
      'home',
      image,
      'file',
    );
    expect(withFile.map((f) => f.name)).toEqual(['chartroom-home.json', 'chartroom-home.svg']);
    expect(JSON.parse(await withFile[0]!.blob.text())).toMatchObject({
      underlay_file: 'chartroom-home.svg',
    });
    await expect(exportFiles(plan, 'home', null, 'embed')).rejects.toThrow('not loaded');
  });

  it('reads an import, refusing anything but one plan file', async () => {
    const upload = vi.fn(async () => `${underlayPath('home')}?v=abc`);
    const json = (p: Plan) => new File([planFileJson(p)], 'p.json', { type: 'application/json' });
    expect(await readImport([], 'home', null, upload, () => false)).toMatchObject({ ok: false });
    const ok = await readImport([json(emptyPlan('Imported'))], 'home', 'up', upload, () => false);
    expect(ok).toMatchObject({
      ok: true,
      plan: { name: 'Imported', floor_id: 'up' },
      image: null,
    });
    expect(upload).not.toHaveBeenCalled();
    // The editor went while the file was read: nothing to report to.
    expect(
      await readImport([json(emptyPlan('Imported'))], 'home', null, upload, () => true),
    ).toBeNull();
  });
});

describe('inspector panels', () => {
  it("commits a wall's new thickness through the context, reading the plan when it changes", () => {
    let plan = wallPlan();
    const ctx: PanelContext = {
      get plan() {
        return plan;
      },
      hass: undefined,
      commit: (p) => (plan = p),
    };
    const remove = vi.fn();
    const el = itemPanel(ctx, { kind: 'wall', id: 'w' }, remove) as unknown as FakeElement;
    const input = all(el).find((n) => n.getAttribute('name') === 'thickness')!;
    // Another change lands before this one: it is kept.
    plan = { ...plan, name: 'Renamed' };
    Object.assign(input, { value: '20', valueAsNumber: 20 });
    input.dispatchEvent({ type: 'change' });
    expect(plan.walls[0]!.thickness).toBeCloseTo(0.2);
    expect(plan.name).toBe('Renamed');
    all(el)
      .find((n) => n.getAttribute('data-action') === 'delete')!
      .dispatchEvent({ type: 'click' });
    expect(remove).toHaveBeenCalledOnce();
    expect(itemPanel(ctx, { kind: 'wall', id: 'gone' }, remove)).toBeNull();
  });
});
