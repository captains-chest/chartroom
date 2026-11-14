import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Hass } from '../src/ha-types';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { PlanEditor } from '../src/plan-editor';
import { dataUrl, planFileJson } from '../src/plan-file';
import { PlanView } from '../src/plan-view';
import { installFakeDom } from './fake-dom';

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

installFakeDom();

type Node = {
  children?: (Node | string)[];
  getAttribute?(k: string): string | null;
  textContent?: string;
  files?: File[];
  listeners?: Map<string, Set<(e: unknown) => void>>;
};

/** The first element under `el` that `match` accepts. */
function find(el: Node, match: (n: Node) => boolean): Node | null {
  if (match(el)) return el;
  for (const c of el.children ?? []) {
    if (typeof c === 'string') continue;
    const n = find(c, match);
    if (n) return n;
  }
  return null;
}

/** The text under the inspector's ignored-underlay hint, or null when there is none. */
function ignoredHint(el: Node): string | null {
  if (el.getAttribute?.('data-hint') === 'underlay-ignored')
    return el.children!.filter((c) => typeof c === 'string').join('');
  for (const c of el.children ?? []) {
    if (typeof c === 'string') continue;
    const t = ignoredHint(c);
    if (t !== null) return t;
  }
  return null;
}

function editor(
  plan: Plan,
  underlayIgnored?: boolean,
  hass?: Hass,
  save: (plan: Plan) => Promise<void> = async () => {},
): PlanEditor {
  const view = new PlanView(true);
  view.setPlan(plan);
  return new PlanEditor({
    view,
    hass: () => hass,
    save,
    planId: 'home',
    plan,
    underlayIgnored,
  });
}

describe('editor underlay panel', () => {
  it('tells the admin when the stored underlay was ignored, until an image is back', () => {
    const plan = emptyPlan('Home');
    expect(ignoredHint(editor(plan, true).inspector as unknown as Node)).toMatch(
      /pointed outside Chartroom.*Import the image again/,
    );
    expect(ignoredHint(editor(plan).inspector as unknown as Node)).toBeNull();
    const own: Plan = {
      ...plan,
      underlay: {
        url: '/api/chartroom/underlay/home',
        width_px: 100,
        height_px: 50,
        scale: 0.05,
        origin: [0, 0],
        opacity: 0.5,
      },
    };
    expect(ignoredHint(editor(own, true).inspector as unknown as Node)).toBeNull();
  });
});

/** A promise and the functions that settle it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Pick `files` in the inspector's file input `name`. */
function pick(ed: PlanEditor, name: string, files: File[]): void {
  const input = find(ed.inspector as unknown as Node, (n) => n.getAttribute?.('name') === name);
  input!.files = files;
  for (const fn of input!.listeners!.get('change')!) fn(new Event('change'));
}

const saveState = (ed: PlanEditor): string | undefined =>
  find(ed.toolbar as unknown as Node, (n) => n.getAttribute?.('class') === 'save-state')
    ?.textContent;

/** Whether leaving the page now would ask first. */
function leaveAsks(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

const STORED = '/api/chartroom/underlay/home?v=0123456789ab';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
const png = (): File => new File([PNG], 'drawing.png', { type: 'image/png' });

describe('editor image upload while leaving', () => {
  let upload: ReturnType<typeof deferred<Response>>;
  let hass: Hass;
  let saved: Plan[];
  const save = async (plan: Plan): Promise<void> => void saved.push(plan);
  const answer = (ok: boolean): void =>
    upload.resolve({ ok, status: ok ? 200 : 500, json: async () => ({ url: STORED }) } as Response);

  vi.stubGlobal('createImageBitmap', async () => ({ width: 200, height: 100, close() {} }));
  const open: PlanEditor[] = [];
  const make = (): PlanEditor => {
    upload = deferred<Response>();
    saved = [];
    hass = { fetchWithAuth: vi.fn(() => upload.promise) } as unknown as Hass;
    const ed = editor(emptyPlan('Home'), false, hass, save);
    open.push(ed);
    return ed;
  };
  afterEach(async () => {
    // Settle anything left and stop the editors listening to the page.
    answer(true);
    await Promise.all(open.splice(0).map((ed) => ed.close()));
  });

  it('asks before leaving the page while an underlay image uploads', async () => {
    const ed = make();
    expect(leaveAsks()).toBe(false);
    pick(ed, 'underlay', [png()]);
    await vi.waitFor(() => expect(hass.fetchWithAuth).toHaveBeenCalled());
    expect(leaveAsks()).toBe(true);
  });

  it('waits at Done for an underlay image still uploading, then saves it', async () => {
    const ed = make();
    pick(ed, 'underlay', [png()]);
    await vi.waitFor(() => expect(hass.fetchWithAuth).toHaveBeenCalled());
    let closed = false;
    const closing = ed.close().then((r) => ((closed = true), r));
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(saveState(ed)).toBe('Uploading image…');
    answer(true);
    expect(await closing).toBeNull();
    expect(ed.plan.underlay?.url).toBe(STORED);
    expect(saved.at(-1)?.underlay?.url).toBe(STORED);
  });

  it('closes after an upload that fails at Done, saying why', async () => {
    const ed = make();
    pick(ed, 'underlay', [png()]);
    await vi.waitFor(() => expect(hass.fetchWithAuth).toHaveBeenCalled());
    const closing = ed.close();
    answer(false);
    expect(await closing).toBe('The underlay image was not imported: upload failed (500)');
    expect(ed.plan.underlay ?? null).toBeNull();
    expect(saved).toEqual([]);
    expect(leaveAsks()).toBe(false);
  });

  it("waits at Done for a plan file's image still uploading", async () => {
    const ed = make();
    const plan: Plan = {
      ...emptyPlan('Imported'),
      underlay: {
        url: STORED,
        width_px: 200,
        height_px: 100,
        scale: 0.05,
        origin: [0, 0],
        opacity: 0.5,
      },
    };
    const text = planFileJson(plan, await dataUrl(new Blob([PNG], { type: 'image/png' })));
    pick(ed, 'plan-file', [new File([text], 'home.json', { type: 'application/json' })]);
    await vi.waitFor(() => expect(hass.fetchWithAuth).toHaveBeenCalled());
    expect(leaveAsks()).toBe(true);
    const closing = ed.close();
    answer(true);
    expect(await closing).toBeNull();
    expect(saved.at(-1)?.name).toBe('Imported');
    expect(saved.at(-1)?.underlay?.url).toBe(STORED);
  });
});
