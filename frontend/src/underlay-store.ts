// The underlay image on screen: one owner for its blob URL and the versions kept for Undo. Kept
// apart from underlay.ts (importing and uploading images) so the card need not load that code.
import type { Hass } from './ha-types';
import { underlayPlanId } from './underlay-url';

/** How many image versions the store keeps, so Undo and Redo across an image need no download. */
export const KEPT_IMAGES = 3;

/**
 * The one owner of the underlay image: it fetches a plan's image, keeps the last few versions as
 * blobs (keyed by their `?v=` URL, which names the content, so they never go stale), and owns the
 * blob URL the view draws, revoking the one it replaces. The panel and the editor both just say
 * which image to `show`; a show overtakes any earlier one still loading.
 *
 * Only plan `planId`'s own image is ever fetched: the fetch carries the user's token, and a plan
 * stored before the integration checked the URL may point anywhere.
 */
export class UnderlayStore {
  readonly #hass: () => Hass | undefined;
  readonly #draw: (blobUrl: string | null) => void;
  readonly #keep: number;
  /** Image versions by URL, least recently used first. */
  readonly #blobs = new Map<string, Blob>();
  readonly #loading = new Map<string, Promise<Blob | null>>();
  /** The image URL asked for last (shown, or loading), and the one on screen. */
  #url: string | null = null;
  #shown: string | null = null;
  #blobUrl: string | null = null;
  /** Bumped by every show, so a load that was overtaken shows nothing. */
  #generation = 0;

  /** `draw` puts a blob URL (or none) on the plan view; the store revokes it when it moves on. */
  constructor(
    hass: () => Hass | undefined,
    draw: (blobUrl: string | null) => void,
    keep = KEPT_IMAGES,
  ) {
    this.#hass = hass;
    this.#draw = draw;
    this.#keep = keep;
  }

  /** The image URL shown or loading, or null. */
  get url(): string | null {
    return this.#url;
  }

  /**
   * Show plan `planId`'s image at `url` (none for null, or for a URL that is not the plan's own),
   * from the kept versions or else fetched. Failures are ignored: the plan works without it.
   * Resolves once it is shown, or overtaken.
   */
  async show(planId: string | null, url: string | null): Promise<void> {
    const own = url && planId && underlayPlanId(url) === planId ? url : null;
    if (own !== null && own === this.#shown) return;
    const generation = ++this.#generation;
    this.#url = own;
    const kept = own ? this.#take(own) : null;
    if (!own || kept) return this.#display(own, kept);
    this.#display(null, null);
    const blob = await this.#fetch(own);
    if (blob && generation === this.#generation) this.#display(own, blob);
  }

  /** Show the image just stored at `url`, without fetching it back. */
  put(url: string, blob: Blob): void {
    this.#generation++;
    this.#url = url;
    this.#remember(url, blob);
    this.#display(url, blob);
  }

  /** The image at `url`, when it is kept (to export it). */
  blob(url: string): Blob | null {
    return this.#blobs.get(url) ?? null;
  }

  /** Drop the image and every kept version. */
  dispose(): void {
    this.#generation++;
    this.#url = null;
    this.#blobs.clear();
    this.#display(null, null);
  }

  #display(url: string | null, blob: Blob | null): void {
    if (this.#blobUrl) URL.revokeObjectURL(this.#blobUrl);
    this.#shown = blob ? url : null;
    this.#blobUrl = blob ? URL.createObjectURL(blob) : null;
    this.#draw(this.#blobUrl);
  }

  /** A kept version, now the most recently used. */
  #take(url: string): Blob | null {
    const blob = this.#blobs.get(url);
    if (blob) this.#remember(url, blob);
    return blob ?? null;
  }

  #remember(url: string, blob: Blob): void {
    this.#blobs.delete(url);
    this.#blobs.set(url, blob);
    for (const old of this.#blobs.keys()) {
      if (this.#blobs.size <= this.#keep) break;
      this.#blobs.delete(old);
    }
  }

  /** One fetch per URL at a time; the image is kept once it is in. */
  #fetch(url: string): Promise<Blob | null> {
    let loading = this.#loading.get(url);
    if (!loading) {
      loading = (async () => {
        try {
          const res = await this.#hass()?.fetchWithAuth?.(url);
          if (!res?.ok) return null;
          const blob = await res.blob();
          this.#remember(url, blob);
          return blob;
        } catch {
          // Offline or gone: the plan shows without its drawing.
          return null;
        } finally {
          this.#loading.delete(url);
        }
      })();
      this.#loading.set(url, loading);
    }
    return loading;
  }
}
