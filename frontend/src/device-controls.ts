// Tapping and holding device markers outside the editor: tap toggles (locks ask first); a hold,
// right-click or the context-menu key opens the radial menu of what the device can do (Details
// among it: Home Assistant's more-info dialog). Hovering a marker or source with the mouse, or
// focusing a marker from the keyboard, shows what it is (a popover).
import { itemEntities } from './device-entities';
import {
  DevicePopover,
  devicePopoverStyles,
  popoverContent,
  type PopoverContent,
} from './device-popover';
import type { MenuAction } from './device-actions';
import type { DeviceMenu } from './device-menu';
import { deviceName, tapAction } from './devices';
import type { Hass } from './ha-types';
import type { Point } from './plan/types';
import type { PlanView, PointerDelegate } from './plan-view';
import { button, h } from './ui';

/** How long a press must last to count as a hold. */
export const HOLD_MS = 500;
/** How long after a hold's lift the mouse events a browser sends for it are ignored. */
const LIFT_MS = 300;
/** A press that moves further than this is a pan, not a tap. */
const SLOP_PX = 8;
/** How long the mouse rests on a marker before its popover shows. */
const SHOW_MS = 400;
/** How long the popover stays after the mouse leaves its marker, so the mouse can reach it. */
const HIDE_MS = 200;
/** How often an open popover refreshes its "5 min ago". */
const TICK_MS = 30_000;

interface Press {
  el: SVGElement;
  entity: string;
  id: string;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  held: boolean;
  moved: boolean;
}

export class DeviceControls implements PointerDelegate {
  readonly dialog: HTMLDialogElement;
  /** What the hovered or focused marker is (`.device-popover`). */
  readonly popover: DevicePopover;
  #showTimer: ReturnType<typeof setTimeout> | undefined;
  #hideTimer: ReturnType<typeof setTimeout> | undefined;
  #tick: ReturnType<typeof setInterval> | undefined;
  #press: Press | null = null;
  /** The marker under the last right-button press, if any. */
  #rightPress: { el: SVGElement; x: number; y: number } | null = null;
  /** The radial menu, once it has opened (its code loads then). */
  #menu: DeviceMenu | null = null;
  #menuLoad: Promise<typeof import('./device-menu')> | null = null;
  /** Bumped by each opening and dismissal: an opening still loading the menu then gives up. */
  #menuTicket = 0;
  #lastInfo = 0;
  readonly #confirmText: HTMLElement;
  readonly #confirmButton: HTMLButtonElement;
  #answer: ((ok: boolean) => void) | null = null;

  constructor(
    readonly view: PlanView,
    /** Fires hass-more-info and hass-notification events (the panel or card element). */
    readonly host: HTMLElement,
    readonly hass: () => Hass | undefined,
  ) {
    this.#confirmText = h('p');
    this.#confirmButton = button('OK', () => this.#close(true), { class: 'primary' });
    this.dialog = h(
      'dialog',
      { class: 'confirm', 'aria-label': 'Confirm' },
      this.#confirmText,
      h(
        'div',
        { class: 'actions' },
        button('Cancel', () => this.#close(false)),
        this.#confirmButton,
      ),
    );
    this.dialog.addEventListener('close', () => this.#close(false));
    this.popover = new DevicePopover(view.el);
    view.el.addEventListener('keydown', (e) => this.#key(e));
    view.el.addEventListener('pointerover', (e) => this.#over(e));
    // Hidden while zooming; a pan starts with a press, below.
    view.el.addEventListener('wheel', () => this.#hide(), { passive: true });
    view.el.addEventListener('pointerout', (e) => this.#out(e));
    // Keyboard focus only: a click or tap focuses the marker too, without :focus-visible.
    view.el.addEventListener('focusin', (e) => {
      const el = this.#marker(e.target);
      if (el?.matches(':focus-visible')) this.#show(el);
    });
    view.el.addEventListener('focusout', (e) => {
      if (e.target === this.popover.anchor) this.#hide();
    });
    // The view captures the pointer on press, so the contextmenu after a right-click goes to the
    // <svg>, not the marker: remember the marker the press started on.
    view.el.addEventListener('pointerdown', (e) => {
      this.#unswallow();
      clearTimeout(this.#showTimer);
      // A press on the marker shown keeps it (a tap's new state shows); a pan hides it.
      if (this.#target(e.target) !== this.popover.anchor) this.#hide();
      // Any press outside the menu closes it.
      if (!this.#menu?.el.contains(e.target as Node)) this.#closeMenu();
      const el = e.button === 2 ? this.#marker(e.target) : null;
      this.#rightPress = el ? { el, x: e.clientX, y: e.clientY } : null;
    });
    view.el.addEventListener('contextmenu', (e) => {
      const r = this.#rightPress;
      this.#rightPress = null;
      // A right-drag that moved is a pan, not a click.
      const el =
        this.#marker(e.target) ??
        (r && Math.hypot(e.clientX - r.x, e.clientY - r.y) <= SLOP_PX ? r.el : null);
      if (!el || !this.active) return;
      const press = this.#press;
      // A long touch fires contextmenu too: it is the hold (the lift does not tap).
      if (press) {
        clearTimeout(press.timer);
        if (press.held) return;
        press.held = true;
      }
      void this.openMenu(el);
    });
  }

  /** Take over pointer handling of the view (after the editor closes). */
  attach(): void {
    this.view.setDelegate(this);
  }

  get active(): boolean {
    return this.view.delegate === this;
  }

  #marker(target: EventTarget | null): SVGElement | null {
    return (target as Element | null)?.closest?.<SVGElement>('[data-kind=device]') ?? null;
  }

  /** A marker or a source (an access point or radio) under `target`. */
  #target(target: EventTarget | null): SVGElement | null {
    return (
      (target as Element | null)?.closest?.<SVGElement>('[data-kind=device], [data-kind=source]') ??
      null
    );
  }

  #over(e: PointerEvent): void {
    if (e.pointerType === 'touch' || !this.active) return;
    if (this.popover.el.contains(e.target as Node)) {
      clearTimeout(this.#hideTimer);
      return;
    }
    const el = this.#target(e.target);
    // Buttons down: a pan or a press passing over.
    if (!el || e.buttons) return;
    clearTimeout(this.#hideTimer);
    if (el === this.popover.anchor) return;
    clearTimeout(this.#showTimer);
    // From one marker to the next, the popover follows at once.
    this.#showTimer = setTimeout(() => this.#show(el), this.popover.anchor ? 0 : SHOW_MS);
  }

  #out(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const pop = this.popover.el;
    const from = this.#target(e.target) ?? (pop.contains(e.target as Node) ? pop : null);
    if (!from || from.contains(e.relatedTarget as Node | null)) return;
    clearTimeout(this.#showTimer);
    clearTimeout(this.#hideTimer);
    this.#hideTimer = setTimeout(() => this.#hide(), HIDE_MS);
  }

  /** What the popover says for a marker or source, or null for one no longer on the plan. */
  #content(el: SVGElement): PopoverContent | null {
    const plan = this.view.plan;
    const hass = this.hass();
    const id = el.dataset['id'];
    if (el.dataset['kind'] === 'device') {
      const d = plan?.devices?.find((x) => x.id === id);
      return d
        ? popoverContent(itemEntities(plan, hass).get(d.id) ?? [d.entity_id], d.device_id, hass)
        : null;
    }
    const entity = plan?.sources.find((x) => x.id === id)?.entity_id;
    return entity ? popoverContent([entity], hass?.entities?.[entity]?.device_id, hass) : null;
  }

  #show(el: Element): void {
    const content =
      this.active && el.isConnected && !this.#menu?.anchor ? this.#content(el as SVGElement) : null;
    if (!content) return this.#hide();
    this.popover.show(el, content);
    if (this.#tick) return;
    this.#tick = setInterval(() => this.statesChanged(), TICK_MS);
    // Esc dismisses it wherever focus is (a mouse hover leaves focus outside the plan).
    document.addEventListener('keydown', this.#escape);
  }

  readonly #escape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.#hide();
  };

  /** The plan was replaced, the view released or the editor opens: popover and menu are stale. */
  reset(): void {
    this.#unswallow();
    this.#hide();
    this.cancel();
    this.#closeMenu();
  }

  /** Close the menu, and drop an opening still loading it. */
  #closeMenu(): void {
    this.#menuTicket++;
    this.#menu?.close(false);
  }

  #hide(): void {
    clearTimeout(this.#showTimer);
    clearTimeout(this.#hideTimer);
    if (this.#tick) {
      clearInterval(this.#tick);
      this.#tick = undefined;
      document.removeEventListener('keydown', this.#escape);
    }
    this.popover.hide();
  }

  /** New states (or the History slider moved): an open popover follows them. */
  statesChanged(): void {
    if (!this.active) this.#closeMenu();
    const anchor = this.popover.anchor;
    if (anchor) this.#show(anchor);
  }

  /**
   * The view moved (panned, zoomed, fitted, resized): the popover follows. The menu closes, unless
   * only the box changed size (a tab added elsewhere, the window): then it follows its marker.
   */
  viewChanged(resized = false): void {
    this.popover.place();
    if (resized) this.#menu?.place();
    else this.#closeMenu();
  }

  down(_p: Point, e: PointerEvent): boolean {
    const el = e.button === 0 ? this.#marker(e.target) : null;
    // A press that closes the menu does nothing else on a marker (elsewhere it may pan).
    if (this.#menu?.anchor) {
      this.#closeMenu();
      this.#press = null;
      return !!el;
    }
    if (!el) return false;
    const entity = el.dataset['entity']!;
    const press: Press = {
      el,
      entity,
      id: el.dataset['id']!,
      x: e.clientX,
      y: e.clientY,
      held: false,
      moved: false,
      timer: setTimeout(() => {
        press.held = true;
        void this.openMenu(el);
      }, HOLD_MS),
    };
    this.#press = press;
    return true;
  }

  move(_p: Point, e: PointerEvent): void {
    const p = this.#press;
    if (!p || p.moved) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) {
      p.moved = true;
      clearTimeout(p.timer);
    }
  }

  cancel(): void {
    const p = this.#press;
    if (p) clearTimeout(p.timer);
    this.#press = null;
  }

  up(_p: Point, e: PointerEvent): void {
    const p = this.#press;
    if (!p) return;
    clearTimeout(p.timer);
    if (!p.held && !p.moved) void this.tap(p.id, p.entity);
    else if (p.held) {
      // A hold slid to a menu item and released there picks it. One released in place does not,
      // even over an item (a menu moved in from the view's edge can put one over the marker).
      if (p.moved && this.#menu?.anchor === p.el) this.#menu.pickAt(e.clientX, e.clientY);
      this.#swallowLift(e.clientX, e.clientY);
    }
    // Keep the press a moment so the contextmenu that follows a long touch is ignored.
    setTimeout(() => {
      if (this.#press === p) this.#press = null;
    }, 50);
  }

  /**
   * The mousedown and click a browser may send at a hold's lift (`x`, `y`) neither pick an item
   * again nor move focus out of the menu (which would close it). Retired by the next press in the
   * plan, a reset, or `LIFT_MS`; a press elsewhere is not near the lift.
   */
  #swallowLift(x: number, y: number): void {
    this.#unswallow();
    const swallow = (c: Event): void => {
      const m = c as MouseEvent;
      if (Math.hypot(m.clientX - x, m.clientY - y) > SLOP_PX) return;
      c.stopPropagation();
      c.preventDefault();
      if (c.type === 'click') this.#unswallow();
    };
    const types = ['mousedown', 'click'] as const;
    for (const type of types) document.addEventListener(type, swallow, true);
    const stop = (): void => {
      clearTimeout(timer);
      for (const type of types) document.removeEventListener(type, swallow, true);
      if (this.#unswallow === stop) this.#unswallow = () => {};
    };
    const timer = setTimeout(stop, LIFT_MS);
    this.#unswallow = stop;
  }

  #unswallow: () => void = () => {};

  #key(e: KeyboardEvent): void {
    const el = this.#marker(e.target);
    if (!el || !this.active) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void this.tap(el.dataset['id']!, el.dataset['entity']!);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      void this.openMenu(el);
    }
  }

  /** Open the radial menu on marker `el` (its code loads the first time). */
  async openMenu(el: SVGElement): Promise<void> {
    this.#hide();
    const ticket = ++this.#menuTicket;
    const load = (this.#menuLoad ??= import('./device-menu'));
    // A press outside the plan while the menu still loads drops this opening too.
    const outside = (e: Event): void => {
      if (!e.composedPath().includes(this.view.el)) this.#closeMenu();
    };
    document.addEventListener?.('pointerdown', outside, true);
    const { DeviceMenu, deviceActions } = await load.finally(() =>
      document.removeEventListener?.('pointerdown', outside, true),
    );
    const plan = this.view.plan;
    const d = plan?.devices?.find((x) => x.id === el.dataset['id']);
    if (ticket !== this.#menuTicket || !d || !el.isConnected || !this.active) return;
    const hass = this.hass();
    const entities = itemEntities(plan, hass).get(d.id) ?? [d.entity_id];
    const menu = (this.#menu ??= new DeviceMenu(this.view.el, (a, m) => this.#choose(a, m)));
    if (menu.anchor === el) return;
    const name = deviceName(el.dataset['entity']!, d.device_id, hass);
    menu.open(el, name, deviceActions(entities, hass));
  }

  #choose(action: MenuAction, marker: Element): void {
    if (action.type === 'more-info') return this.#moreInfo(action.entity);
    const { domain, service, data, confirm } = action;
    void this.#call((marker as SVGElement).dataset['id']!, action.entity, domain, service, {
      data,
      confirm,
    });
  }

  /** Home Assistant's own details dialog for an entity. */
  #moreInfo(entityId: string): void {
    const now = performance.now();
    if (now - this.#lastInfo < 400) return;
    this.#lastInfo = now;
    this.host.dispatchEvent(
      new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }),
    );
  }

  async tap(id: string, entityId: string): Promise<void> {
    const hass = this.hass();
    const action = tapAction(entityId, hass?.states?.[entityId]);
    if (action.type === 'more-info' || !hass?.callService) {
      this.#moreInfo(entityId);
      return;
    }
    await this.#call(id, entityId, action.domain, action.service, action);
  }

  /** Call a service on an entity of marker `id` (as a tap does), asking first with `confirm`. */
  async #call(
    id: string,
    entityId: string,
    domain: string,
    service: string,
    { data, confirm }: { data?: Record<string, unknown>; confirm?: string },
  ): Promise<void> {
    const hass = this.hass();
    // The History slider's states cannot act: show details instead, as a tap does.
    if (!hass?.callService) return this.#moreInfo(entityId);
    if (confirm && !(await this.confirm(confirm, service))) return;
    this.view.markers.markPending(id);
    try {
      await hass.callService(domain, service, { ...data, entity_id: entityId });
    } catch (err) {
      this.host.dispatchEvent(
        new CustomEvent('hass-notification', {
          detail: { message: `${entityId}: ${(err as Error).message ?? String(err)}` },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  /** Ask before acting (locks). Resolves false on Cancel or Esc. */
  confirm(text: string, service: string): Promise<boolean> {
    // A new question cancels one still open.
    this.#answer?.(false);
    this.#answer = null;
    this.#confirmText.textContent = text;
    this.#confirmButton.textContent = service.charAt(0).toUpperCase() + service.slice(1);
    return new Promise((resolve) => {
      this.#answer = resolve;
      if (!this.dialog.open) this.dialog.showModal();
      this.#confirmButton.focus();
    });
  }

  #close(ok: boolean): void {
    const answer = this.#answer;
    this.#answer = null;
    if (this.dialog.open) this.dialog.close();
    answer?.(ok);
  }
}

export const deviceControlStyles = `${devicePopoverStyles}
  dialog.confirm { border: 0; border-radius: 12px; padding: 16px 20px; min-width: 240px;
    background: var(--card-background-color, #fff); color: var(--primary-text-color, #212121);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  dialog.confirm::backdrop { background: rgba(0,0,0,0.3); }
  dialog.confirm p { margin: 0 0 16px; }
  dialog.confirm .actions { display: flex; justify-content: flex-end; gap: 8px; }
`;
