// Tiny DOM helpers. Text always goes in as text nodes, never as HTML.
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** `n` and the noun, plural unless there is exactly one: "1 sensor", "3 sensors". */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

function apply(el: Element, attrs: Attrs, children: Child[]): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs, children);
  return el;
}

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, children);
  return el;
}

export function button(label: string, onClick: () => void, attrs: Attrs = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', ...attrs }, label);
  b.addEventListener('click', onClick);
  return b;
}

/** A labelled form row. */
export function field(label: string, control: HTMLElement): HTMLLabelElement {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}

export function numberInput(
  value: number,
  onChange: (v: number) => void,
  attrs: Attrs = {},
): HTMLInputElement {
  const input = h('input', { type: 'number', value: String(value), ...attrs });
  input.addEventListener('change', () => {
    const v = input.valueAsNumber;
    if (Number.isFinite(v)) onChange(v);
  });
  return input;
}

export function textInput(
  value: string,
  onChange: (v: string) => void,
  attrs: Attrs = {},
): HTMLInputElement {
  const input = h('input', { type: 'text', value, ...attrs });
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export function select(
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
  attrs: Attrs = {},
): HTMLSelectElement {
  const el = h('select', attrs);
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    opt.selected = o.value === value;
    el.append(opt);
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
