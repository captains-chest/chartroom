// The radial menu a right-click, a long press or the context-menu key opens on a device marker:
// ring 1 around the marker, and ring 2 further out from an item with more options. HTML in the
// plan box, the same size on screen at any zoom; loaded the first time it opens. What the rings
// hold is `deviceActions`.
import type { MenuAction, MenuItem, Ring } from './device-actions';
import { h } from './ui';

export { deviceActions } from './device-actions';

/** Ring 2 lies this much further out than ring 1 (px). */
const GAP2 = 64;
/** The rings are ellipses this much wider than high, to fit the items' labels. */
const WIDE = 1.4;
/** Angle between ring-2 items at most (radians). */
const STEP2 = 0.45;
/** Room for an item past its ring and from the view's edges (px): half its width, and height. */
const PAD_X = 64;
const PAD_Y = 24;

export class DeviceMenu {
  readonly el: HTMLDivElement;
  #anchor: Element | null = null;
  #ring2: HTMLElement | null = null;
  /** The ring-1 item ring 2 opened from. */
  #parent: HTMLButtonElement | null = null;
  /** Ring 1's vertical radius (px). */
  #r = 0;
  #outer = 0;

  constructor(
    readonly box: HTMLElement,
    /** An item that acts was chosen; the menu has closed (focus is back on `anchor`). */
    readonly choose: (action: MenuAction, anchor: Element) => void,
  ) {
    this.el = h('div', { class: 'device-menu', hidden: true }, h('style', {}, deviceMenuStyles));
    this.el.addEventListener('keydown', (e) => this.#key(e));
    // Tabbing away closes it; a click outside, a pan or a zoom is the controls' to tell.
    this.el.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !this.el.contains(to)) this.close(false);
    });
    box.append(this.el);
  }

  /** The marker the menu is open on, or null when closed. */
  get anchor(): Element | null {
    return this.#anchor;
  }

  /** Open `ring` around `anchor` (named `label` for screen readers), its first item focused. */
  open(anchor: Element, label: string, ring: Ring): void {
    this.close(false);
    this.#anchor = anchor;
    this.#r = ring.length > 5 ? 84 : 68;
    this.#outer = ring.some((i) => i.ring) ? this.#r + GAP2 : this.#r;
    this.el.hidden = false;
    const first = this.#ring(
      ring,
      label,
      this.#r,
      ring.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / ring.length),
    );
    this.place();
    document.addEventListener('pointerdown', this.#outside, true);
    first.focus();
  }

  /** Close the menu; `refocus` puts focus back on its marker. */
  close(refocus: boolean): void {
    const anchor = this.#anchor;
    if (!anchor) return;
    this.#anchor = null;
    this.#ring2 = this.#parent = null;
    document.removeEventListener('pointerdown', this.#outside, true);
    for (const ring of this.el.querySelectorAll('[role=menu]')) ring.remove();
    this.el.hidden = true;
    if (refocus) (anchor as SVGElement).focus?.();
  }

  /** Centred on the marker, moved in as far as the rings need to stay inside the view. */
  place(): void {
    const a = this.#anchor;
    if (!a) return;
    const box = this.box.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const clamp = (v: number, m: number, max: number): number =>
      max < 2 * m ? max / 2 : Math.max(m, Math.min(v, max - m));
    const x = clamp((r.left + r.right) / 2 - box.left, this.#outer * WIDE + PAD_X, box.width);
    const y = clamp((r.top + r.bottom) / 2 - box.top, this.#outer + PAD_Y, box.height);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** A ring of `items` at radius `r`, item i at `angles[i]`; returns its first item. */
  #ring(items: Ring, label: string, r: number, angles: number[]): HTMLButtonElement {
    const ring = h('div', { role: 'menu', 'aria-label': label });
    items.forEach((item, i) => {
      const x = Math.round(Math.cos(angles[i]!) * r * WIDE);
      const y = Math.round(Math.sin(angles[i]!) * r);
      const b = h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          tabindex: -1,
          'aria-haspopup': item.ring ? 'menu' : null,
          'aria-expanded': item.ring ? 'false' : null,
          'data-angle': angles[i],
          style: `transform: translate(calc(${x}px - 50%), calc(${y}px - 50%))`,
        },
        item.label,
      );
      b.addEventListener('click', () => this.#pick(item, b));
      ring.append(b);
    });
    this.el.append(ring);
    return ring.firstElementChild as HTMLButtonElement;
  }

  /** An item with a ring opens it (or closes it, opened already); any other acts. */
  #pick(item: MenuItem, b: HTMLButtonElement): void {
    const anchor = this.#anchor;
    if (!anchor) return;
    if (item.ring) {
      const again = this.#parent === b;
      this.#close2();
      if (again) return;
      const m = item.ring.length;
      const step = Math.min(STEP2, (2 * Math.PI) / m);
      const at = Number(b.dataset['angle']);
      const first = this.#ring(
        item.ring,
        item.label,
        this.#r + GAP2,
        item.ring.map((_, i) => at + (i - (m - 1) / 2) * step),
      );
      this.#ring2 = first.parentElement;
      this.#parent = b;
      b.setAttribute('aria-expanded', 'true');
      first.focus();
    } else if (item.action) {
      this.close(true);
      this.choose(item.action, anchor);
    }
  }

  #close2(): void {
    this.#parent?.setAttribute('aria-expanded', 'false');
    this.#ring2?.remove();
    this.#ring2 = this.#parent = null;
  }

  #key(e: KeyboardEvent): void {
    const b = e.target as HTMLElement;
    const items = [...(b.parentElement?.children ?? [])] as HTMLElement[];
    const i = items.indexOf(b);
    const to = (j: number): void => items[(j + items.length) % items.length]?.focus();
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        to(i + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        to(i - 1);
        break;
      case 'Home':
        to(0);
        break;
      case 'End':
        to(-1);
        break;
      case 'Escape':
      case 'Backspace':
        if (this.#ring2?.contains(b)) {
          this.#parent?.focus();
          this.#close2();
        } else this.close(true);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  readonly #outside = (e: Event): void => {
    const path = e.composedPath();
    // Presses in the plan are the controls' (a marker press that closes the menu does not tap).
    if (!path.includes(this.el) && !path.includes(this.box)) this.close(false);
  };
}

const deviceMenuStyles = `
  .device-menu { position: absolute; left: 0; top: 0; z-index: 3; width: 0; height: 0; }
  .device-menu[hidden], svg.plan.editing ~ .device-menu { display: none; }
  .device-menu [role=menuitem] { position: absolute; left: 0; top: 0; box-sizing: border-box;
    min-width: 44px; max-width: 120px; height: 36px; padding: 0 12px; border: 0; border-radius: 18px;
    font: inherit; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
  .device-menu [role=menuitem]:is(:hover, :focus-visible) { outline: 2px solid var(--primary-color, #03a9f4);
    outline-offset: -2px; }
  .device-menu [aria-expanded=true] { background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff); }
`;
