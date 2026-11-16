// Tapping and holding device markers outside the editor: tap toggles (locks ask first), hold,
// right-click or the context-menu key open Home Assistant's more-info dialog.
import { tapAction } from './devices';
import type { Hass } from './ha-types';
import type { Point } from './plan/types';
import type { PlanView, PointerDelegate } from './plan-view';
import { button, h } from './ui';

/** How long a press must last to count as a hold. */
export const HOLD_MS = 500;
/** A press that moves further than this is a pan, not a tap. */
const SLOP_PX = 8;

interface Press {
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
  #press: Press | null = null;
  /** The marker under the last right-button press, if any. */
  #rightPress: { entity: string; x: number; y: number } | null = null;
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
    view.el.addEventListener('keydown', (e) => this.#key(e));
    // The view captures the pointer on press, so the contextmenu after a right-click goes to the
    // <svg>, not the marker: remember the marker the press started on.
    view.el.addEventListener('pointerdown', (e) => {
      const el = e.button === 2 ? this.#marker(e.target) : null;
      this.#rightPress = el ? { entity: el.dataset['entity']!, x: e.clientX, y: e.clientY } : null;
    });
    view.el.addEventListener('contextmenu', (e) => {
      const r = this.#rightPress;
      this.#rightPress = null;
      // A right-drag that moved is a pan, not a click.
      const entity =
        this.#marker(e.target)?.dataset['entity'] ??
        (r && Math.hypot(e.clientX - r.x, e.clientY - r.y) <= SLOP_PX ? r.entity : undefined);
      // A long touch fires contextmenu too; the hold already opened the dialog.
      if (entity && this.active && !this.#press?.held) this.#moreInfo(entity);
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

  down(_p: Point, e: PointerEvent): boolean {
    const el = e.button === 0 ? this.#marker(e.target) : null;
    if (!el) return false;
    const entity = el.dataset['entity']!;
    const press: Press = {
      entity,
      id: el.dataset['id']!,
      x: e.clientX,
      y: e.clientY,
      held: false,
      moved: false,
      timer: setTimeout(() => {
        press.held = true;
        this.#moreInfo(entity);
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

  up(): void {
    const p = this.#press;
    if (!p) return;
    clearTimeout(p.timer);
    if (!p.held && !p.moved) void this.tap(p.id, p.entity);
    // Keep the press a moment so the contextmenu that follows a long touch is ignored.
    setTimeout(() => {
      if (this.#press === p) this.#press = null;
    }, 50);
  }

  #key(e: KeyboardEvent): void {
    const el = this.#marker(e.target);
    if (!el || !this.active) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void this.tap(el.dataset['id']!, el.dataset['entity']!);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      this.#moreInfo(el.dataset['entity']!);
    }
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
    if (action.confirm && !(await this.confirm(action.confirm, action.service))) return;
    this.view.markers.markPending(id);
    try {
      await hass.callService(action.domain, action.service, { entity_id: entityId });
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

export const deviceControlStyles = `
  dialog.confirm { border: 0; border-radius: 12px; padding: 16px 20px; min-width: 240px;
    background: var(--card-background-color, #fff); color: var(--primary-text-color, #212121);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  dialog.confirm::backdrop { background: rgba(0,0,0,0.3); }
  dialog.confirm p { margin: 0 0 16px; }
  dialog.confirm .actions { display: flex; justify-content: flex-end; gap: 8px; }
`;
