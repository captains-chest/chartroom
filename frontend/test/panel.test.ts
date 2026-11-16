import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { CLOSE_WAIT_MS } from '../src/editor/session';
import { emptyPlan } from '../src/plan/functions';
import type { Plan, Underlay } from '../src/plan/models';
import { dataUrl, planFileJson } from '../src/plan-file';
import { underlayPath } from '../src/underlay-url';
import { fakeWsApi, imageResponse, jsonResponse, PanelHarness, PNG, settle } from './panel-harness';

vi.mock('../src/api', async (real) => ({
  ...(await real<typeof import('../src/api')>()),
  wsApi: (c: Parameters<typeof fakeWsApi>[0]) => fakeWsApi(c),
}));
vi.mock('../src/field-worker', () => ({ pingWorker: () => new Promise(() => {}) }));
vi.mock('../src/heat-layer', () => ({
  HeatLayer: class {
    dispose = vi.fn();
    setLayer = vi.fn();
    setView = vi.fn();
    setHass = vi.fn();
    setPlan = vi.fn();
    onReadings = null;
  },
  renderValueLabels: () => {},
  declutterLabels: () => {},
}));

const IMAGE = `${underlayPath('home')}?v=abc123`;

const underlay = (url: string): Underlay => ({
  url,
  width_px: 200,
  height_px: 100,
  scale: 0.05,
  origin: [0, 0],
  opacity: 0.5,
});

const home = (): Plan => emptyPlan('Home');
const withImage = (): Plan => ({ ...home(), underlay: underlay(IMAGE) });

/** The text of a plan file of a plan named `name`, with an embedded underlay image. */
async function planFileText(name: string): Promise<string> {
  const plan = { ...emptyPlan(name), underlay: underlay(`${underlayPath('other')}?v=abc123`) };
  return planFileJson(plan, await dataUrl(new Blob([PNG], { type: 'image/png' })));
}

const planFile = async (name: string): Promise<File> =>
  new File([await planFileText(name)], 'chartroom-other.json', { type: 'application/json' });

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('panel underlay and the editor (#36)', () => {
  it("shares the panel's load with the editor instead of fetching the image twice", async () => {
    const t = await PanelHarness.mount({ home: withImage() });
    expect(t.fetch.to(IMAGE)).toHaveLength(1);

    await t.openEditor();
    expect(t.fetch.to(IMAGE)).toHaveLength(1);
    t.fetch.to(IMAGE)[0]!.respond(imageResponse());
    await settle();
    expect(t.panel.view.underlayUrl).toMatch(/^blob:/);
  });

  it('shows the image of a load still running when the editor closes', async () => {
    const t = await PanelHarness.mount({ home: withImage() });
    await t.openEditor();
    await t.closeEditor();
    const loads = t.fetch.to(IMAGE);
    expect(loads).toHaveLength(1);
    loads[0]!.respond(imageResponse());
    await settle();
    expect(t.panel.view.underlayUrl).toMatch(/^blob:/);
  });

  it('keeps the image on screen on close, without fetching it again', async () => {
    const t = await PanelHarness.mount({ home: withImage() });
    t.fetch.to(IMAGE)[0]!.respond(imageResponse());
    await settle();
    const image = t.panel.view.underlayUrl;
    expect(image).toMatch(/^blob:/);

    await t.openEditor();
    await t.closeEditor();
    expect(t.fetch.to(IMAGE)).toHaveLength(1);
    expect(t.panel.view.underlayUrl).toBe(image);
  });
});

describe('saving when the panel or the page goes (#38)', () => {
  it('listens for leaving the page only while the editor is open', async () => {
    const t = await PanelHarness.mount({ home: home() });
    const on = (): number[] => [
      t.page.listening('pagehide'),
      t.page.listening('beforeunload'),
      t.page.document.listening('visibilitychange'),
    ];
    const before = on();

    await t.openEditor();
    expect(on()).toEqual(before.map((n) => n + 1));

    // While open, leaving the page saves the pending change at once.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    t.pickPlanFiles([new File([planFileJson(emptyPlan('Left'))], 'left.json')]);
    await settle();
    expect(t.api.plans.get('home')!.name).toBe('Home');
    t.page.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(t.api.plans.get('home')!.name).toBe('Left');

    await t.closeEditor();
    expect(on()).toEqual(before);
  });

  it("saves an open editor's pending change when the panel leaves the page", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    t.pickPlanFiles([new File([planFileJson(emptyPlan('Moved'))], 'moved.json')]);
    await settle();
    expect(t.api.plans.get('home')!.name).toBe('Home');

    // No timer runs: the save is the one disconnectedCallback starts.
    await t.remove();
    expect(t.api.plans.get('home')!.name).toBe('Moved');
    expect(t.editing).toBe(true);
    await t.closeEditor();
  });
});

describe('a plan import and closing the editor (#19, #50)', () => {
  it('waits at Done for an image still uploading, then keeps the import', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    t.pickPlanFiles([await planFile('Imported')]);
    await settle();
    const [upload] = t.fetch.to(underlayPath('home'), 'POST');
    expect(upload).toBeDefined();

    await t.toggleEditor();
    expect(t.editing).toBe(true);
    upload!.respond(jsonResponse({ url: `${underlayPath('home')}?v=def456` }));
    await settle();
    await vi.runAllTimersAsync();
    await settle();

    expect(t.editing).toBe(false);
    expect(t.api.plans.get('home')!.name).toBe('Imported');
    expect(t.panel.plan!.name).toBe('Imported');
  });

  it('waits at Done for a file still being read, then keeps the import', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    let read!: () => void;
    const gate = new Promise<void>((r) => (read = r));
    // A file the browser is slow to read (a large one, or from a network drive).
    class SlowFile extends File {
      override async text(): Promise<string> {
        await gate;
        return super.text();
      }
    }
    t.pickPlanFiles([new SlowFile([await planFileText('Imported')], 'imported.json')]);
    await settle();

    await t.toggleEditor();
    expect(t.editing).toBe(true);
    read();
    await settle();
    const [upload] = t.fetch.to(underlayPath('home'), 'POST');
    upload?.respond(jsonResponse({ url: `${underlayPath('home')}?v=def456` }));
    await settle();
    await vi.runAllTimersAsync();
    await settle();

    expect(t.editing).toBe(false);
    expect(t.api.plans.get('home')!.name).toBe('Imported');
    expect(t.panel.plan!.name).toBe('Imported');
  });
});

describe('following plan saves made elsewhere (#78)', () => {
  const named = (name: string): Plan => ({ ...home(), name });

  it('shows a save made in another tab', async () => {
    const t = await PanelHarness.mount({ home: home() });
    await t.saveElsewhere('home', named('Ground'));
    expect(t.panel.plan!.name).toBe('Ground');
    expect(t.panel.view.plan!.name).toBe('Ground');
  });

  it('shows a save that moved the plan to another floor', async () => {
    const t = await PanelHarness.mount({ home: home() });
    // Its tab changes from the plan's own to the floor's.
    (t.hass as { floors?: unknown }).floors = {
      upstairs: { floor_id: 'upstairs', name: 'Upstairs', level: 1 },
    };
    await t.saveElsewhere('home', { ...named('Moved'), floor_id: 'upstairs' });
    expect(t.find((el) => el.getAttribute('data-tab') === 'floor:upstairs')).toBeDefined();
    expect(t.panel.plan!.name).toBe('Moved');
    expect(t.panel.view.plan!.name).toBe('Moved');
  });

  it('adds the tab of a plan created elsewhere', async () => {
    const t = await PanelHarness.mount({ home: home() });
    expect(t.find((el) => el.getAttribute('data-plan') === 'attic')).toBeUndefined();
    await t.saveElsewhere('attic', named('Attic'));
    expect(t.find((el) => el.getAttribute('data-plan') === 'attic')).toBeDefined();
    expect(t.panel.plan!.name).toBe('Home');
  });

  it('stops listening off the page, and catches up when it is back', async () => {
    const t = await PanelHarness.mount({ home: home() });
    expect(t.api.subscribers).toBe(1);
    await t.remove();
    expect(t.api.subscribers).toBe(0);

    await t.saveElsewhere('home', named('Meanwhile'));
    expect(t.panel.plan!.name).toBe('Home');
    await t.attach();
    expect(t.api.subscribers).toBe(1);
    expect(t.panel.plan!.name).toBe('Meanwhile');
  });

  it('loads the plan again when Home Assistant reconnects', async () => {
    const t = await PanelHarness.mount({ home: home() });
    // Saved while the connection was down: no event reached the panel.
    t.api.plans.set('home', named('Offline'));
    await t.reconnect();
    expect(t.panel.plan!.name).toBe('Offline');
  });

  it("keeps an open editor's copy, and shows the stored plan at Done", async () => {
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    await t.saveElsewhere('home', named('Elsewhere'));
    expect(t.panel.plan!.name).toBe('Home');
    expect(t.panel.view.plan!.name).toBe('Home');

    await t.closeEditor();
    expect(t.panel.plan!.name).toBe('Elsewhere');
    expect(t.panel.view.plan!.name).toBe('Elsewhere');
  });

  it("saves an editor's later change over one made elsewhere", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    await t.saveElsewhere('home', named('Elsewhere'));
    t.pickPlanFiles([new File([planFileJson(emptyPlan('Mine'))], 'mine.json')]);
    await settle();

    await t.closeEditor();
    expect(t.api.plans.get('home')!.name).toBe('Mine');
    expect(t.panel.plan!.name).toBe('Mine');
  });
});

describe('closing the editor when something is stuck or failed (#65, #66)', () => {
  /** The panel's status line. */
  const status = (t: PanelHarness): string => {
    const el = t.find((e) => e.getAttribute('class') === 'status');
    return el?.textContent ?? '';
  };

  it('stops waiting at Done for an upload that hangs, aborts it and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    t.pickPlanFiles([await planFile('Imported')]);
    await settle();
    const [upload] = t.fetch.to(underlayPath('home'), 'POST');
    expect(upload!.init?.signal?.aborted).toBe(false);

    await t.toggleEditor();
    expect(t.editing).toBe(true);
    await vi.advanceTimersByTimeAsync(CLOSE_WAIT_MS);
    await settle();

    expect(t.editing).toBe(false);
    expect(upload!.init?.signal?.aborted).toBe(true);
    expect(status(t)).toContain('The underlay image was still uploading and was dropped');
    expect(t.api.plans.get('home')!.name).toBe('Home');
  });

  it('says in the status line when the last change could not be saved at Done', async () => {
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    vi.spyOn(t.api, 'savePlan').mockRejectedValue(new Error('Connection lost'));
    t.pickPlanFiles([
      new File([planFileJson(emptyPlan('Renamed'))], 'renamed.json', { type: 'application/json' }),
    ]);
    await settle();
    expect(t.panel.plan!.name).toBe('Renamed');

    await t.closeEditor();
    expect(status(t)).toContain('Your last change was not saved: Connection lost.');
    expect(t.api.plans.get('home')!.name).toBe('Home');
  });
});

describe('dragging in the editor', () => {
  it('redraws the plan once a frame, as a preview until the drag ends', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => void (frames[id - 1] = () => {}));
    try {
      const plan = home();
      plan.sources = [{ id: 's', kind: 'sensor', entity_id: 'sensor.t', position: [1, 1] }];
      const t = await PanelHarness.mount({ home: plan });
      await t.openEditor();
      const view = t.panel.view;
      const setPlan = vi.spyOn(view, 'setPlan');
      const hit = { dataset: { kind: 'source', id: 's' } };
      const target = { closest: (sel: string) => (sel === '[data-kind]' ? hit : null) };
      const e = { button: 0, clientX: 0, clientY: 0, target } as unknown as PointerEvent;
      const d = view.delegate!;
      expect(d.down([1, 1], e)).toBe(true);
      setPlan.mockClear();

      d.move([1.5, 1], e);
      d.move([2, 1], e);
      d.move([2.5, 1], e);
      expect(setPlan).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      frames[0]!(0);
      expect(setPlan).toHaveBeenCalledOnce();
      expect(setPlan.mock.calls[0]![2]).toBe(true);
      expect(setPlan.mock.calls[0]![0]?.sources[0]?.position).toEqual([2.5, 1]);

      d.move([3, 1], e);
      d.up([3, 1], e);
      expect(setPlan).toHaveBeenCalledTimes(2);
      expect(setPlan.mock.calls[1]![2]).toBe(false);
      expect(t.panel.plan?.sources[0]?.position).toEqual([3, 1]);
      // The frame the last move asked for was cancelled by the drop's render.
      frames[1]!(0);
      expect(setPlan).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
