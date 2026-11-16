// The editor's inspector as a list of keyed parts. Each part says what it is built from (`deps`,
// compared by identity); a render rebuilds only the parts whose deps changed and keeps the others'
// elements in place, so a field being typed in is not replaced when something it doesn't show
// changes (Home Assistant sends a state change from anywhere in the house).

export interface Part {
  /** Which part this is, stable across renders (a panel's kind, or the selected item's). */
  readonly key: string;
  /** What the part is built from; the part is rebuilt when one of them is not identical. */
  readonly deps: readonly unknown[];
  build(): HTMLElement | null;
}

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

export class Inspector {
  #parts = new Map<string, { deps: readonly unknown[]; node: HTMLElement | null }>();
  #nodes: HTMLElement[] = [];

  constructor(readonly el: HTMLElement) {}

  /** Show `parts` in order, building only those that are new or whose deps changed. */
  render(parts: readonly Part[]): void {
    const next = new Map<string, { deps: readonly unknown[]; node: HTMLElement | null }>();
    const nodes: HTMLElement[] = [];
    for (const p of parts) {
      const old = this.#parts.get(p.key);
      const node = old && same(old.deps, p.deps) ? old.node : p.build();
      next.set(p.key, { deps: p.deps, node });
      if (node) nodes.push(node);
    }
    this.#parts = next;
    // Putting the same elements back would still move them, and take the focus from a field.
    if (nodes.length === this.#nodes.length && nodes.every((n, i) => n === this.#nodes[i])) return;
    this.#nodes = nodes;
    this.el.replaceChildren(...nodes);
  }
}
