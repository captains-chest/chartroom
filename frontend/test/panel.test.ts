import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
  it("drops the panel's own load when the editor opens", async () => {
    const t = await PanelHarness.mount({ home: withImage() });
    const [panelLoad] = t.fetch.to(IMAGE);
    expect(t.fetch.to(IMAGE)).toHaveLength(1);

    await t.openEditor();
    const [, editorLoad] = t.fetch.to(IMAGE);
    expect(editorLoad).toBeDefined();
    editorLoad!.respond(imageResponse());
    await settle();
    const editorImage = t.panel.view.underlayUrl;
    expect(editorImage).toMatch(/^blob:/);

    // The panel's fetch ends late: the editor's image stays.
    panelLoad!.respond(imageResponse());
    await settle();
    expect(t.panel.view.underlayUrl).toBe(editorImage);
  });

  it("loads the image again on close when the editor's load was dropped", async () => {
    const t = await PanelHarness.mount({ home: withImage() });
    await t.openEditor();
    await t.closeEditor();
    const loads = t.fetch.to(IMAGE);
    expect(loads).toHaveLength(3);

    // The panel's first load and the editor's were both dropped.
    loads[0]!.respond(imageResponse());
    loads[1]!.respond(imageResponse());
    await settle();
    expect(t.panel.view.underlayUrl).toBeNull();

    loads[2]!.respond(imageResponse());
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

describe('a plan import and closing the editor (#19)', () => {
  it('drops an import whose image finishes uploading after the editor closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const t = await PanelHarness.mount({ home: home() });
    await t.openEditor();
    t.pickPlanFiles([await planFile('Imported')]);
    await settle();
    const [upload] = t.fetch.to(underlayPath('home'), 'POST');
    expect(upload).toBeDefined();

    await t.closeEditor();
    upload!.respond(jsonResponse({ url: `${underlayPath('home')}?v=def456` }));
    await settle();
    await vi.runAllTimersAsync();
    await settle();

    expect(t.api.plans.get('home')!.name).toBe('Home');
    expect(t.panel.plan!.name).toBe('Home');
    expect(t.panel.view.underlayUrl).toBeNull();
  });

  it('drops an import whose file is read after the editor closed', async () => {
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

    await t.closeEditor();
    read();
    await settle();
    await vi.runAllTimersAsync();
    await settle();

    // Not even its image is uploaded.
    expect(t.fetch.to(underlayPath('home'), 'POST')).toEqual([]);
    expect(t.api.plans.get('home')!.name).toBe('Home');
    expect(t.panel.plan!.name).toBe('Home');
  });
});
