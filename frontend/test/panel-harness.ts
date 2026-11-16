// Mounts the real ChartroomPanel under the fake DOM, with a FakeApi behind a fake hass, so tests
// can open and close the editor and take the panel off the page. Home Assistant's websocket and the
// image fetches are stand-ins the test answers; the panel and editor code is the real thing.
//
// The test file mocks what needs a browser and the API module, before anything imports them:
//   vi.mock('../src/api', async (real) => ({ ...(await real()), wsApi: (c) => fakeWsApi(c) }));
//   (an arrow: vi.mock is hoisted above this module's import)
//   vi.mock('../src/field-worker', () => ({ pingWorker: () => new Promise(() => {}) }));
//   (plus heat-layer, as in editor-underlay.test.ts)
import type { ChartroomApi } from '../src/api';
import type { ChartroomPanel } from '../src/chartroom-panel';
import type { Hass, HassConnection } from '../src/ha-types';
import type { Plan } from '../src/plan/models';
import { FakeApi } from './fake-api';
import { type FakeElement, type FakePage, installFakeDom } from './fake-dom';

installFakeDom();

const apis = new WeakMap<HassConnection, ChartroomApi>();

/** Stands in for `wsApi`: the FakeApi behind a harness connection. */
export function fakeWsApi(c: HassConnection): ChartroomApi {
  const api = apis.get(c);
  if (!api) throw new Error('not a harness connection');
  return api;
}

/** A tiny PNG's bytes (only the signature matters). */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);

export interface FetchCall {
  readonly path: string;
  readonly init: RequestInit | undefined;
  respond(res: Response): void;
}

/** `hass.fetchWithAuth`, whose calls wait until the test answers them, in any order. */
export class FakeFetch {
  readonly calls: FetchCall[] = [];
  readonly fn = (path: string, init?: RequestInit): Promise<Response> =>
    new Promise((respond) => this.calls.push({ path, init, respond }));

  /** The calls of `method` (GET by default) to `path` so far. */
  to(path: string, method = 'GET'): FetchCall[] {
    return this.calls.filter((c) => c.path === path && (c.init?.method ?? 'GET') === method);
  }
}

export const imageResponse = (): Response =>
  new Response(new Blob([PNG], { type: 'image/png' }), { status: 200 });

export const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Let pending promises, the editor's lazy import included, run (timers are not advanced). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

type Node = FakeElement | string;

function* walk(el: FakeElement): Generator<FakeElement> {
  yield el;
  for (const c of el.children as Node[]) if (typeof c !== 'string') yield* walk(c);
  if (el.shadowRoot) yield* walk(el.shadowRoot);
}

export class PanelHarness {
  readonly api = new FakeApi();
  readonly fetch = new FakeFetch();
  readonly hass: Hass;
  readonly page = window as unknown as FakePage;
  readonly #body: FakeElement = document.createElement('body') as unknown as FakeElement;
  /** The connection's 'ready' listeners (Home Assistant reconnected). */
  readonly #ready = new Set<() => void>();
  panel!: ChartroomPanel;

  private constructor() {
    const connection: HassConnection = {
      sendMessagePromise: () => Promise.reject(new Error('the harness has no websocket')),
      addEventListener: (_e, fn) => void this.#ready.add(fn),
      removeEventListener: (_e, fn) => void this.#ready.delete(fn),
    };
    apis.set(connection, this.api);
    this.hass = { connection, user: { is_admin: true }, states: {}, fetchWithAuth: this.fetch.fn };
  }

  /** Put a panel on the page with these stored plans, and wait for the first one to load. */
  static async mount(plans: Record<string, Plan>): Promise<PanelHarness> {
    const t = new PanelHarness();
    for (const [id, plan] of Object.entries(plans)) t.api.plans.set(id, structuredClone(plan));
    const { ChartroomPanel } = await import('../src/chartroom-panel');
    // Load the editor's lazy chunk now, so opening it later only waits for promises.
    await import('../src/plan-editor');
    t.panel = new ChartroomPanel();
    // The browser calls connectedCallback on insertion, then Home Assistant sets hass.
    t.#body.append(t.panel as unknown as FakeElement);
    t.panel.connectedCallback();
    t.panel.hass = t.hass;
    await settle();
    return t;
  }

  get #el(): FakeElement {
    return this.panel as unknown as FakeElement;
  }

  /** The first element in the panel (shadow root included) that `match` picks. */
  find(match: (el: FakeElement) => boolean): FakeElement | undefined {
    for (const el of walk(this.#el)) if (match(el)) return el;
    return undefined;
  }

  get editing(): boolean {
    return this.#el.hasAttribute('editing');
  }

  /** Click Edit, or Done while editing. */
  async toggleEditor(): Promise<void> {
    const edit = this.find((el) => el.getAttribute('class') === 'edit');
    if (!edit || edit.hidden) throw new Error('no Edit button');
    edit.dispatchEvent({ type: 'click' });
    await settle();
  }

  async openEditor(): Promise<void> {
    if (this.editing) throw new Error('the editor is already open');
    await this.toggleEditor();
    if (!this.editing) throw new Error('the editor did not open');
  }

  async closeEditor(): Promise<void> {
    if (!this.editing) throw new Error('the editor is not open');
    await this.toggleEditor();
    if (this.editing) throw new Error('the editor did not close');
  }

  /** Pick `files` in the editor's Plan file › Import field (does not settle). */
  pickPlanFiles(files: File[]): void {
    const input = this.find((el) => el.getAttribute('name') === 'plan-file');
    if (!input) throw new Error('no plan file input (is the editor open?)');
    Object.assign(input, { files });
    input.dispatchEvent({ type: 'change' });
  }

  /** Store `plan` as `id` from elsewhere (another tab or user), and send its plan event. */
  async saveElsewhere(id: string, plan: Plan): Promise<void> {
    await this.api.savePlan(id, plan);
    await settle();
  }

  /** Home Assistant's connection came back (its 'ready' event). */
  async reconnect(): Promise<void> {
    for (const fn of this.#ready) fn();
    await settle();
  }

  /** Put the panel back on the page after `remove()`. */
  async attach(): Promise<void> {
    this.#body.append(this.#el);
    this.panel.connectedCallback();
    await settle();
  }

  /** Take the panel off the page, as Home Assistant does when it switches panels. */
  async remove(): Promise<void> {
    this.#el.remove();
    this.panel.disconnectedCallback();
    await settle();
  }
}
