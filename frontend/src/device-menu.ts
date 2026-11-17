// A device's wheel: a disc around its marker, one segment per choice, and a hub in the middle
// with the device's name (closes it) or, one level down, Back. A segment with more options opens
// them as the next level, grown out of that segment; Back or Esc goes up a level, then closes.
// A click, a right-click, a hold or the context-menu key opens it (device-controls.ts); a hold can
// slide to a segment and lift there to pick it, or rest on one with options to open its level.
// HTML in the plan box, the same size on screen at any zoom; loaded the first time it opens. What
// the levels hold is `deviceActions`.
import type { Icon, MenuAction, MenuItem, Ring } from './device-actions';
import { GLYPHS, type Glyph } from './devices';
import { h, s } from './ui';

export { deviceActions } from './device-actions';

/** Line icons on a 24-unit grid, as GLYPHS: the entities' and the actions'. */
const ICONS: Record<Icon | 'back', string> = {
  ...GLYPHS,
  power: 'M12 3v8M7.5 6.5a7 7 0 1 0 9 0',
  brightness:
    'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  colour:
    'M12 3a9 9 0 0 0 0 18c1 0 1.5-.7 1.5-1.5 0-1-.8-1.4-.8-2.3 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4C21 6.7 17 3 12 3zM7.5 11.5h.01M9.5 7.5h.01M14.5 7.5h.01M16.5 11.5h.01',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 11v6M12 7.5h.01',
  route:
    'M6 16a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM18 3a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM8.5 18.5H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  stop: 'M7 7h10v10H7z',
  swing: 'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  back: 'M14.5 5.5L8 12l6.5 6.5',
};

/** The hub's radius (px). */
const HUB = 38;
/** Room between segments, and around them inside the disc (px). */
const GAP = 3;
/** How long a hold rests on a segment with options before their level opens. */
const DWELL_MS = 450;
/** A hold must move this far from where a level opened under it before its lift picks there. */
const SLOP_PX = 10;
/** Room kept clear of the view's edges (px). */
const EDGE = 8;
/** How long a level takes to leave (the styles' animations). */
const LEAVE_MS = 180;

/** The disc's radius for a level of `n` segments (px). */
const radius = (n: number): number => (n <= 4 ? 100 : n <= 6 ? 112 : 124);

/** The largest disc of `ring` and the levels below it. */
const largest = (ring: Ring): number =>
  Math.max(radius(ring.length), ...ring.map((i) => (i.ring ? largest(i.ring) : 0)));

const round = (v: number): number => Math.round(v * 10) / 10;

/**
 * Segment `i` of `n` on a disc of radius `r`, from the hub out with `GAP` between it and its
 * neighbours (the whole ring for one segment, even-odd): its box from the disc's centre (px), and
 * its outline as an SVG path in that box.
 */
function sector(
  r: number,
  i: number,
  n: number,
): { box: [number, number, number, number]; d: string } {
  const outer = r - GAP;
  const inner = HUB + GAP;
  if (n === 1) {
    const circle = (q: number): string =>
      `M${r - q} ${r}a${q} ${q} 0 1 0 ${2 * q} 0a${q} ${q} 0 1 0 ${-2 * q} 0z`;
    return { box: [-r, -r, 2 * r, 2 * r], d: circle(outer) + circle(inner) };
  }
  const mid = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  // The same width of gap at both edges: a smaller angle out where the arc is longer.
  const o = Math.PI / n - GAP / 2 / outer;
  const k = Math.PI / n - GAP / 2 / inner;
  const pt = (q: number, a: number): [number, number] => [q * Math.cos(a), q * Math.sin(a)];
  const corners = [pt(outer, mid - o), pt(outer, mid + o), pt(inner, mid + k), pt(inner, mid - k)];
  // The box: the corners, and the outer arc where it is furthest left, right, up or down.
  const extremes = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((q) => (q * Math.PI) / 2 - 2 * Math.PI)
    .filter((a) => a > mid - o && a < mid + o)
    .map((a) => pt(outer, a));
  const xs = [...corners, ...extremes].map((p) => p[0]);
  const ys = [...corners, ...extremes].map((p) => p[1]);
  const [x0, y0] = [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys))];
  const box: [number, number, number, number] = [
    x0,
    y0,
    Math.ceil(Math.max(...xs)) - x0,
    Math.ceil(Math.max(...ys)) - y0,
  ];
  const at = ([x, y]: [number, number]): string => `${round(x - x0)} ${round(y - y0)}`;
  const large = n === 2 ? 1 : 0;
  const [a, b, c, d] = corners;
  return {
    box,
    d: `M${at(a!)}A${outer} ${outer} 0 ${large} 1 ${at(b!)}L${at(c!)}A${inner} ${inner} 0 ${large} 0 ${at(d!)}Z`,
  };
}

/** Where segment `i` of `n` puts its icon and words, from the disc's centre (px). */
function facePoint(r: number, i: number, n: number): [number, number] {
  const mid = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const q = (HUB + r) / 2;
  return [Math.round(q * Math.cos(mid)), Math.round(q * Math.sin(mid))];
}

const icon = (name: Icon | 'back', cls = 'dm-icon'): SVGSVGElement =>
  s(
    'svg',
    { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    s('path', { d: ICONS[name] }),
  );

/** A level open in the wheel: its segments, and where it grew from in the level above. */
interface Level {
  items: Ring;
  label: string;
  /** The segment it opened from, as a point from the centre (px); none for the first level. */
  origin: [number, number] | null;
  /** Which segment of the level above it opened from. */
  from: number;
  /** Drawn while it is the level shown. */
  el: HTMLElement | null;
}

export class DeviceMenu {
  readonly el: HTMLDivElement;
  readonly #hub: HTMLButtonElement;
  #anchor: Element | null = null;
  #levels: Level[] = [];
  #name = '';
  #glyph: Glyph | null = null;
  #outer = 0;
  /** The segment or hub under a sliding hold, and its dwell. */
  #hot: HTMLElement | null = null;
  #dwell: ReturnType<typeof setTimeout> | undefined;
  #at: [number, number] = [0, 0];
  /** Where a dwell opened a level under the hold: a lift near it picks nothing. */
  #opened: [number, number] | null = null;

  constructor(
    readonly box: HTMLElement,
    /** A segment that acts was chosen; the menu has closed (focus is back on `anchor`). */
    readonly choose: (action: MenuAction, anchor: Element) => void,
  ) {
    this.#hub = h('button', { type: 'button', class: 'dm-hub', tabindex: -1 });
    this.#hub.addEventListener('click', () => this.#back());
    this.el = h(
      'div',
      { class: 'device-menu', hidden: true },
      h('style', {}, deviceMenuStyles),
      this.#hub,
    );
    this.el.addEventListener('keydown', (e) => this.#key(e));
    // Focus shows as a ring only while the keyboard drives the wheel (opened with a key, or moved
    // around with one), not after a tap, click or hold put focus on its first segment.
    box.addEventListener('keydown', () => this.el.classList.add('kbd'), true);
    box.addEventListener('pointerdown', () => this.el.classList.remove('kbd'), true);
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

  /**
   * Open `ring` around `anchor`, the device named `label` (and drawn with `glyph`) in the hub, its
   * first segment focused (with a ring when a `keyboard` key opened it).
   */
  open(
    anchor: Element,
    label: string,
    ring: Ring,
    glyph: Glyph | null = null,
    keyboard = false,
  ): void {
    this.close(false);
    this.el.classList.toggle('kbd', keyboard);
    this.#anchor = anchor;
    this.#name = label;
    this.#glyph = glyph;
    this.#outer = largest(ring) + EDGE;
    this.el.hidden = false;
    const first: Level = { items: ring, label, origin: null, from: -1, el: null };
    this.#levels = [first];
    this.#show(first, 'dm-pop');
    this.place();
    document.addEventListener('pointerdown', this.#outside, true);
    this.#focus(0);
  }

  /** Close the menu; `refocus` puts focus back on its marker. */
  close(refocus: boolean): void {
    const anchor = this.#anchor;
    if (!anchor) return;
    this.#anchor = null;
    this.#levels = [];
    this.endSlide();
    document.removeEventListener('pointerdown', this.#outside, true);
    for (const level of this.el.querySelectorAll('.dm-level')) level.remove();
    this.el.hidden = true;
    if (refocus) (anchor as SVGElement).focus?.();
  }

  /**
   * A sliding hold is at client (`x`, `y`): the segment there lights up, and resting on one with
   * options opens their level.
   */
  track(x: number, y: number): void {
    if (!this.#anchor) return;
    this.#at = [x, y];
    const o = this.#opened;
    // Moving off where a rest opened a level lets resting open one again, on the same segment too.
    const freed = !!o && Math.hypot(x - o[0], y - o[1]) > SLOP_PX;
    if (freed) this.#opened = null;
    const t = this.#hit(x, y);
    if (t === this.#hot && !freed) return;
    clearTimeout(this.#dwell);
    if (t !== this.#hot) {
      this.#hot?.classList.remove('hot');
      this.#hot = t;
      t?.classList.add('hot');
    }
    if (t?.hasAttribute('aria-haspopup') && !this.#opened)
      this.#dwell = setTimeout(() => {
        if (this.#hot !== t) return;
        this.#opened = this.#at;
        t.click();
        this.#hot = null;
        this.track(...this.#at);
      }, DWELL_MS);
  }

  /**
   * A hold's lift at client (`x`, `y`): the segment there is picked as a tap picks it (one with
   * options only opens them), the hub goes back or closes; anywhere else, or where a rest just
   * opened a level, nothing.
   */
  pickAt(x: number, y: number): void {
    const o = this.#opened;
    const near = !!o && Math.hypot(x - o[0], y - o[1]) <= SLOP_PX;
    this.endSlide();
    if (this.#anchor && !near) this.#hit(x, y)?.click();
  }

  /** Centred on the marker, moved in as far as the disc needs to stay inside the view. */
  place(): void {
    const a = this.#anchor;
    if (!a) return;
    const box = this.box.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const m = this.#outer;
    const clamp = (v: number, max: number): number =>
      max < 2 * m ? max / 2 : Math.max(m, Math.min(v, max - m));
    const x = clamp((r.left + r.right) / 2 - box.left, box.width);
    const y = clamp((r.top + r.bottom) / 2 - box.top, box.height);
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  #hit(x: number, y: number): HTMLElement | null {
    const root = this.el.getRootNode() as Document | ShadowRoot;
    const t = root
      .elementFromPoint?.(x, y)
      ?.closest<HTMLElement>('.dm-level:not(.dm-leave) [role=menuitem], .dm-hub');
    return t && this.el.contains(t) ? t : null;
  }

  /** A sliding hold ended (lifted or cancelled): nothing stays lit, no rest opens a level. */
  endSlide(): void {
    clearTimeout(this.#dwell);
    this.#hot?.classList.remove('hot');
    this.#hot = null;
    this.#opened = null;
  }

  get #top(): Level | undefined {
    return this.#levels.at(-1);
  }

  /** Draw `level`, the stack's top now, entering as `how`. */
  #show(level: Level, how: string): void {
    const { items, label } = level;
    const n = items.length;
    const r = radius(n);
    const el = h('div', {
      role: 'menu',
      'aria-label': label,
      class: `dm-level ${how}`,
      style: `--r: ${r}px`,
    });
    const [ox, oy] = level.origin ?? [0, 0];
    el.style.transformOrigin = `calc(50% + ${ox}px) calc(50% + ${oy}px)`;
    el.append(h('div', { class: 'dm-disc' }));
    items.forEach((item, i) => el.append(this.#segment(item, i, n, r)));
    this.el.insertBefore(el, this.#hub);
    level.el = el;
    this.#hubShows();
  }

  /** A level's element leaves, animated as `how`, and is gone from screen readers at once. */
  #leave(el: HTMLElement | null, how: string): void {
    if (!el) return;
    el.setAttribute('aria-hidden', 'true');
    el.classList.add('dm-leave', how);
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) el.remove();
    else setTimeout(() => el.remove(), LEAVE_MS);
  }

  #segment(item: MenuItem, i: number, n: number, r: number): HTMLButtonElement {
    const { box, d } = sector(r, i, n);
    const [x0, y0, w, ht] = box;
    const [fx, fy] = facePoint(r, i, n);
    // As wide as the segment is where its words sit.
    const width = n === 1 ? 120 : Math.min(104, 2 * ((HUB + r) / 2) * Math.sin(Math.PI / n) - 10);
    const b = h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        tabindex: -1,
        class: item.unavailable ? 'dm-seg unavailable' : 'dm-seg',
        'aria-label': item.value ? `${item.label}: ${item.value}` : null,
        'aria-haspopup': item.ring ? 'menu' : null,
        style:
          `left: ${r + x0}px; top: ${r + y0}px; width: ${w}px; height: ${ht}px; ` +
          `clip-path: path(${n === 1 ? 'evenodd, ' : ''}'${d}')`,
      },
      s(
        'svg',
        { class: 'dm-shape', viewBox: `0 0 ${w} ${ht}`, 'aria-hidden': 'true' },
        s('path', { d, 'fill-rule': 'evenodd' }),
      ),
      h(
        'span',
        {
          class: 'dm-face',
          style: `left: ${fx - x0}px; top: ${fy - y0}px; max-width: ${Math.round(width)}px`,
        },
        item.swatch
          ? h('span', { class: 'dm-swatch', style: `background: ${item.swatch}` })
          : item.icon
            ? icon(item.icon)
            : null,
        h('span', { class: 'dm-value' }, item.value ?? item.label),
        item.value ? h('span', { class: 'dm-label' }, item.label) : null,
        item.ring ? h('span', { class: 'dm-more', 'aria-hidden': 'true' }) : null,
      ),
    );
    b.addEventListener('click', () => this.#pick(item, i, [fx, fy]));
    return b;
  }

  /** The hub: the device at the first level (closes the wheel), Back and where you are below. */
  #hubShows(): void {
    const deep = this.#levels.length > 1;
    const hub = this.#hub;
    const text = deep ? this.#top!.label : this.#name;
    hub.setAttribute('aria-label', deep ? 'Back' : `Close ${this.#name}`);
    hub.classList.toggle('back', deep);
    const name = h('span', {}, text);
    hub.replaceChildren(
      deep ? icon('back', 'dm-hub-icon') : this.#glyph ? icon(this.#glyph, 'dm-hub-icon') : '',
      name,
    );
    // It wraps at spaces to two lines. A word wider than the hub takes a smaller font, and if it
    // is still too wide, one line cut with an ellipsis (never a break inside the word).
    const wide = (): boolean => name.scrollWidth > name.clientWidth;
    if (wide()) name.classList.add('small');
    if (wide()) name.classList.add('cut');
  }

  #segments(): HTMLElement[] {
    return [...(this.#top?.el?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
  }

  #focus(i: number): void {
    const items = this.#segments();
    items[Math.max(0, Math.min(i, items.length - 1))]?.focus();
  }

  /** A segment with options opens their level, grown out of it; any other acts. */
  #pick(item: MenuItem, i: number, origin: [number, number]): void {
    const anchor = this.#anchor;
    if (!anchor) return;
    if (item.ring) {
      this.#leave(this.#top?.el ?? null, 'dm-out');
      const level: Level = { items: item.ring, label: item.label, origin, from: i, el: null };
      this.#levels.push(level);
      this.#show(level, 'dm-in');
      this.#focus(0);
    } else if (item.action) {
      this.close(true);
      this.choose(item.action, anchor);
    }
  }

  /** Up a level (the segment it opened from focused), or close at the first. */
  #back(): void {
    const top = this.#top;
    if (!top || this.#levels.length < 2) return this.close(true);
    // The level shown shrinks back into its segment as the one above comes back.
    this.#leave(top.el, 'dm-shrink');
    this.#levels.pop();
    this.#show(this.#top!, 'dm-back');
    this.#focus(top.from);
  }

  #key(e: KeyboardEvent): void {
    const b = e.target as HTMLElement;
    const items = this.#segments();
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
        this.#back();
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
  .device-menu { position: absolute; left: 0; top: 0; z-index: 3; width: 0; height: 0;
    --dm-bg: var(--card-background-color, #fff); --dm-fg: var(--primary-text-color, #212121);
    --dm-muted: var(--secondary-text-color, #727272); --dm-accent: var(--primary-color, #03a9f4);
    color: var(--dm-fg); font-size: 12px; line-height: 1.2; }
  .device-menu[hidden], svg.plan.editing ~ .device-menu { display: none; }
  .dm-level { position: absolute; left: calc(-1 * var(--r)); top: calc(-1 * var(--r));
    width: calc(2 * var(--r)); height: calc(2 * var(--r)); }
  .dm-disc { position: absolute; inset: 0; border-radius: 50%; background: var(--dm-bg);
    background: color-mix(in srgb, color-mix(in srgb, var(--dm-fg) 12%, var(--dm-bg)) 80%, transparent);
    -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2); }
  .dm-seg { position: absolute; margin: 0; padding: 0; border: 0; background: none;
    font: inherit; color: inherit; cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent; }
  .dm-shape { position: absolute; inset: 0; width: 100%; height: 100%; }
  .dm-shape path { fill: var(--dm-bg); fill: color-mix(in srgb, var(--dm-bg) 94%, transparent);
    stroke: transparent; stroke-width: 5; transition: fill 0.12s; }
  .dm-seg:is(:hover, .hot) path { fill: color-mix(in srgb, var(--dm-accent) 16%, var(--dm-bg)); }
  .dm-seg:active path, .dm-seg.hot:hover path { fill: color-mix(in srgb, var(--dm-accent) 30%, var(--dm-bg)); }
  .kbd .dm-seg:focus path { stroke: var(--dm-accent); }
  .dm-face { position: absolute; transform: translate(-50%, -50%); display: flex; flex-direction: column;
    align-items: center; gap: 2px; text-align: center; pointer-events: none; }
  .dm-face > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dm-icon { width: 22px; height: 22px; fill: none; stroke: var(--dm-muted); stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.12s; }
  .dm-seg:is(:hover, .hot) .dm-icon, .kbd .dm-seg:focus .dm-icon { stroke: var(--dm-accent); }
  .dm-face .dm-swatch { width: 20px; height: 20px; border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25); }
  .dm-value { font-size: 13px; font-weight: 600; }
  .dm-label { font-size: 11px; color: var(--dm-muted); }
  .dm-seg.unavailable .dm-value { font-style: italic; font-weight: 400; color: var(--disabled-text-color, #9e9e9e); }
  .dm-face .dm-more { width: 14px; height: 2px; margin-top: 1px; border-radius: 1px; background: var(--dm-muted); opacity: 0.6; }
  .dm-hub { position: absolute; left: -${HUB}px; top: -${HUB}px; width: ${2 * HUB}px; height: ${2 * HUB}px;
    box-sizing: border-box; margin: 0; padding: 6px; border: 0; border-radius: 50%; z-index: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
    font: inherit; font-size: 11px; font-weight: 600; line-height: 1.15; cursor: pointer;
    color: var(--dm-fg); background: var(--dm-bg); -webkit-tap-highlight-color: transparent;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--dm-fg) 14%, transparent), 0 2px 6px rgba(0, 0, 0, 0.2);
    transition: background 0.12s; }
  .device-menu:not([hidden]) .dm-hub { animation: dm-pop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1); }
  .dm-hub span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; max-width: ${2 * HUB - 14}px; overflow-wrap: normal; }
  .dm-hub span.small { font-size: 9.5px; }
  .dm-hub span.cut { display: block; white-space: nowrap; text-overflow: ellipsis; }
  .dm-hub:is(:hover, .hot) { background: color-mix(in srgb, var(--dm-accent) 16%, var(--dm-bg)); }
  .dm-hub-icon { width: 16px; height: 16px; flex: none; fill: none; stroke: var(--dm-muted); stroke-width: 2;
    stroke-linecap: round; stroke-linejoin: round; }
  .dm-hub.back .dm-hub-icon { width: 20px; height: 20px; stroke: var(--dm-accent); }
  .dm-pop { animation: dm-pop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1); }
  .dm-in { animation: dm-in 0.22s cubic-bezier(0.2, 0.8, 0.2, 1); }
  .dm-back { animation: dm-back 0.2s cubic-bezier(0.2, 0.8, 0.2, 1); }
  .dm-leave { pointer-events: none; animation: dm-out ${LEAVE_MS}ms ease-in forwards; }
  .dm-leave.dm-shrink { animation-name: dm-shrink; }
  @keyframes dm-pop { from { transform: scale(0.6); opacity: 0; } }
  @keyframes dm-in { from { transform: scale(0.3); opacity: 0; } }
  @keyframes dm-back { from { transform: scale(1.12); opacity: 0; } }
  @keyframes dm-out { to { transform: scale(1.12); opacity: 0; } }
  @keyframes dm-shrink { to { transform: scale(0.3); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .device-menu, .device-menu * { animation: none !important; transition: none !important; }
  }
`;
