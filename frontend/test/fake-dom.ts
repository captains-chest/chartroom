// Just enough DOM for the viewer classes to build their elements under Node (no jsdom): elements
// keep attributes, children and listeners; nothing is laid out or rendered.
type Listener = (e: unknown) => void;

export class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly classList: {
    add(...c: string[]): void;
    remove(...c: string[]): void;
    toggle(c: string, on?: boolean): boolean;
    contains(c: string): boolean;
  };
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty(): void {}, removeProperty(): void {} };
  readonly listeners = new Map<string, Set<Listener>>();
  children: (FakeElement | string)[] = [];
  parent: FakeElement | null = null;
  textContent = '';
  clientWidth = 0;
  clientHeight = 0;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    const classes = new Set<string>();
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
      contains: (c) => classes.has(c),
    };
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attributes.has(k);
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k);
  }
  toggleAttribute(k: string, on = !this.attributes.has(k)): boolean {
    if (on) this.attributes.set(k, '');
    else this.attributes.delete(k);
    return on;
  }
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }
  set hidden(on: boolean) {
    this.toggleAttribute('hidden', on);
  }
  set innerHTML(_html: string) {
    this.replaceChildren();
  }
  get isConnected(): boolean {
    return !!this.parent;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const n of nodes) {
      if (n instanceof FakeElement) {
        n.remove();
        n.parent = this;
      }
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: (FakeElement | string)[]): void {
    for (const c of this.children) if (c instanceof FakeElement) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  querySelector(): FakeElement | null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Calls the listeners for `e.type` (no bubbling); one may remove itself meanwhile. */
  dispatchEvent(e: { type: string }): boolean {
    for (const fn of Array.from(this.listeners.get(e.type) ?? [])) fn(e);
    return true;
  }

  shadowRoot: FakeElement | null = null;
  attachShadow(): FakeElement {
    return (this.shadowRoot = new FakeElement('#shadow-root'));
  }
}

/** The base class custom elements extend: a fake element named after its registered tag. */
class FakeHTMLElement extends FakeElement {
  constructor() {
    super('custom-element');
  }
}

/** An EventTarget that can tell which listeners are on, like the page the editor listens to. */
export class FakeEventTarget extends EventTarget {
  readonly #on = new Map<string, Set<unknown>>();

  override addEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (fn) (this.#on.get(type) ?? this.#on.set(type, new Set()).get(type)!).add(fn);
    super.addEventListener(type, fn, options);
  }

  override removeEventListener(
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.#on.get(type)?.delete(fn);
    super.removeEventListener(type, fn, options);
  }

  /** How many listeners for `type` are on. */
  listening(type: string): number {
    return this.#on.get(type)?.size ?? 0;
  }
}

/** The fake `window`: the page and its document, with listeners that can be counted. */
export type FakePage = FakeEventTarget & {
  document: FakeEventTarget & { visibilityState: string };
};

/** Install the fake `document`, `ResizeObserver`, `CSS`, `window` and custom-element globals (idempotent). */
export function installFakeDom(): void {
  const g = globalThis as Record<string, unknown>;
  g['document'] ??= {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  };
  g['ResizeObserver'] ??= class {
    observe(): void {}
    disconnect(): void {}
  };
  // The plan view re-selects by id after a redraw.
  g['CSS'] ??= { escape: (s: string) => s };
  // The page the editor listens to for leaving (flushOnLeave).
  g['window'] ??= Object.assign(new FakeEventTarget(), {
    document: Object.assign(new FakeEventTarget(), { visibilityState: 'visible' }),
  });
  // What the panel, a custom element, needs from the page.
  g['HTMLElement'] ??= FakeHTMLElement;
  if (!g['customElements']) {
    const defined = new Map<string, unknown>();
    g['customElements'] = {
      get: (name: string) => defined.get(name),
      define: (name: string, ctor: unknown) => void defined.set(name, ctor),
    };
  }
  // Node's own localStorage needs a file to keep it in: an in-memory one instead.
  // (Read the property's descriptor: reading Node's getter warns.)
  if (
    !(Object.getOwnPropertyDescriptor(globalThis, 'localStorage')?.value instanceof FakeStorage)
  ) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new FakeStorage(),
      configurable: true,
      writable: true,
    });
  }
}

class FakeStorage {
  readonly #items = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#items.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#items.set(k, String(v));
  }
  removeItem(k: string): void {
    this.#items.delete(k);
  }
  clear(): void {
    this.#items.clear();
  }
}
