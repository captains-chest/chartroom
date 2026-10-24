// The frontend's build version against the integration's. After an update Home Assistant serves
// the new frontend, but an open tab keeps running the old one until it reloads; when the versions
// differ, the panel and the card show a small prompt to reload.
import type { HassConnection } from './ha-types';
import { button, h } from './ui';

declare const __CHARTROOM_VERSION__: string;

/** This build's version (package.json, which a test keeps equal to the manifest's). */
export const BUILD_VERSION: string = __CHARTROOM_VERSION__;

/** The integration's version when it differs from `build`, else null (also when it cannot tell). */
export async function versionMismatch(
  c: HassConnection,
  build: string = BUILD_VERSION,
): Promise<string | null> {
  try {
    const { version } = await c.sendMessagePromise<{ version: string }>({ type: 'chartroom/info' });
    return version && version !== build ? version : null;
  } catch {
    return null;
  }
}

/** The "Chartroom was updated" prompt. Checks on first connection and whenever it reconnects. */
export class UpdateNotice {
  readonly el: HTMLElement;
  #conn?: HassConnection;

  constructor(reload: () => void = () => location.reload()) {
    this.el = h(
      'div',
      { class: 'update', role: 'status', hidden: true },
      'Chartroom was updated. ',
      button('Reload', reload),
    );
  }

  watch(c: HassConnection | undefined, build: string = BUILD_VERSION): void {
    if (!c || c === this.#conn) return;
    this.#conn = c;
    const check = (): void =>
      void versionMismatch(c, build).then((v) => {
        if (!v) return;
        this.el.dataset['version'] = v;
        this.el.hidden = false;
      });
    check();
    c.addEventListener?.('ready', check);
  }
}

export const updateNoticeStyles = `
  .update { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); z-index: 3;
    display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px; border-radius: 6px;
    font-size: 12px; white-space: nowrap; color: #fff; background: var(--warning-color, #ff9800);
    box-shadow: 0 1px 4px rgba(0,0,0,0.25); }
  .update button { font: inherit; padding: 2px 8px; border-radius: 4px; border: 0; cursor: pointer;
    color: var(--warning-color, #ff9800); background: #fff; }
`;
