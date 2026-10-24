// The history time slider (loaded on demand). It fetches the plan's entities from Home
// Assistant's recorder (raw history, or hourly statistics for sensors over long ranges) and
// shows the plan as it was at the chosen time by handing the view a `hass` whose states are the
// recorded ones. Heatmaps, signal (a source that was unavailable) and markers follow from that.
import type { EntityState, Hass, HassConnection } from './ha-types';
import type { Plan } from './plan';
import { button, h } from './ui';

/** Per entity: times (ms, ascending) and the state from each time on. */
export type Timeline = Map<string, { t: number[]; s: string[] }>;

export const RANGES = [
  { label: '6h', ms: 6 * 3600_000, period: null },
  { label: '24h', ms: 24 * 3600_000, period: null },
  { label: '7d', ms: 7 * 24 * 3600_000, period: 'hour' },
] as const;

/** The entities a plan shows: its sources' and devices' (sensors first, for statistics). */
export const planEntities = (plan: Plan | null): { sensors: string[]; others: string[] } => {
  const sensors = new Set<string>();
  const others = new Set<string>();
  for (const s of plan?.sources ?? [])
    if (s.entity_id) (s.kind === 'sensor' ? sensors : others).add(s.entity_id);
  for (const d of plan?.devices ?? []) others.add(d.entity_id);
  for (const id of sensors) others.delete(id);
  return { sensors: [...sensors], others: [...others] };
};

type Stats = Record<string, { start: number; mean?: number | null }[]>;
type History = Record<string, { s: string; lu?: number; lc?: number }[]>;

/** Fetch what the recorder has for `plan` between `start` and `end` (ms). */
export async function fetchTimeline(
  c: HassConnection,
  plan: Plan | null,
  start: number,
  end: number,
  period: string | null,
): Promise<Timeline> {
  const { sensors, others } = planEntities(plan);
  const tl: Timeline = new Map();
  const iso = (ms: number): string => new Date(ms).toISOString();
  if (period && sensors.length) {
    const r = await c.sendMessagePromise<Stats>({
      type: 'recorder/statistics_during_period',
      start_time: iso(start),
      end_time: iso(end),
      statistic_ids: sensors,
      period,
      types: ['mean'],
    });
    for (const [id, rows] of Object.entries(r)) {
      const ok = rows.filter((x) => x.mean != null);
      if (ok.length)
        tl.set(id, { t: ok.map((x) => +x.start), s: ok.map((x) => String(+x.mean!.toFixed(2))) });
    }
  }
  const rest = [...sensors.filter((id) => !tl.has(id)), ...others];
  if (rest.length) {
    const r = await c.sendMessagePromise<History>({
      type: 'history/history_during_period',
      start_time: iso(start),
      end_time: iso(end),
      entity_ids: rest,
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    for (const [id, rows] of Object.entries(r))
      tl.set(id, { t: rows.map((x) => (x.lu ?? x.lc ?? 0) * 1000), s: rows.map((x) => x.s) });
  }
  return tl;
}

/** The state of each entity at `t`: the last one recorded at or before it (else the first). */
export function statesAt(tl: Timeline, t: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, { t: ts, s }] of tl) {
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ts[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    if (s.length) out.set(id, s[lo]!);
  }
  return out;
}

/** `hass` as it was at `t`: recorded states over the live ones, and no service calls. */
export function hassAt(hass: Hass | undefined, tl: Timeline, t: number): Hass | undefined {
  if (!hass?.states) return hass;
  const states: Record<string, EntityState> = { ...hass.states };
  for (const [id, state] of statesAt(tl, t)) {
    const live = states[id];
    if (live) states[id] = { ...live, state, last_reported: undefined };
  }
  return { ...hass, states, callService: undefined };
}

const fmt = (t: number, ms: number): string =>
  new Date(t).toLocaleString(
    undefined,
    ms > 86400_000
      ? { weekday: 'short', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit', second: '2-digit' },
  );

export interface TimeHost {
  hass(): Hass | undefined;
  plan(): Plan | null;
  /** The time moved: show `view(hass)`. */
  changed(): void;
  /** Back to live. */
  live(): void;
}

/** The slider bar. `view(hass)` is what the plan should show while it is open. */
export class TimeBar {
  readonly el: HTMLElement;
  #host: TimeHost;
  #tl: Timeline = new Map();
  #range: (typeof RANGES)[number] = RANGES[1];
  #at = 0;
  #load = 0;
  #timer = 0;
  #slider: HTMLInputElement;
  #when: HTMLElement;
  #play: HTMLButtonElement;
  #ranges: HTMLButtonElement[];

  constructor(host: TimeHost) {
    this.#host = host;
    this.#play = button('▶', () => this.#toggle(), { class: 'play', 'aria-label': 'Play' });
    this.#ranges = RANGES.map((r) =>
      button(r.label, () => ((this.#range = r), void this.load()), { 'aria-pressed': 'false' }),
    );
    this.#slider = h('input', { type: 'range', step: 1000, 'aria-label': 'Time' });
    this.#slider.addEventListener('input', () => {
      this.#pause();
      this.#seek(this.#slider.valueAsNumber);
    });
    this.#when = h('output', { class: 'when', 'aria-live': 'polite' });
    this.el = h(
      'div',
      { class: 'timebar', role: 'group', 'aria-label': 'History' },
      this.#play,
      ...this.#ranges,
      this.#slider,
      this.#when,
      button('Live', () => host.live(), { class: 'live primary' }),
    );
  }

  get at(): number {
    return this.#at;
  }

  view(hass: Hass | undefined): Hass | undefined {
    return hassAt(hass, this.#tl, this.#at);
  }

  /** (Re)fetch for the current plan and range; keeps the time if it is still in range. */
  async load(): Promise<void> {
    const load = ++this.#load;
    // Whole seconds, so the slider's one-second steps land on them.
    const end = Math.ceil(Date.now() / 1000) * 1000;
    const start = end - this.#range.ms;
    for (const [i, b] of this.#ranges.entries())
      b.setAttribute('aria-pressed', String(RANGES[i] === this.#range));
    Object.assign(this.#slider, { min: start, max: end, disabled: true });
    this.#when.textContent = 'Loading…';
    const c = this.#host.hass()?.connection;
    try {
      if (!c) throw new Error();
      const tl = await fetchTimeline(c, this.#host.plan(), start, end, this.#range.period);
      if (load !== this.#load) return;
      this.#tl = tl;
      this.#slider.disabled = false;
      this.el.dataset['entities'] = String(tl.size);
      this.#seek(this.#at >= start && this.#at <= end ? this.#at : end);
    } catch {
      if (load === this.#load) this.#when.textContent = 'History unavailable';
    }
  }

  #seek(t: number): void {
    this.#at = t;
    this.#slider.valueAsNumber = t;
    this.#when.textContent = fmt(t, this.#range.ms);
    this.el.dataset['at'] = String(t);
    this.#host.changed();
  }

  #toggle(): void {
    if (this.#timer) return this.#pause();
    const min = +this.#slider.min;
    const max = +this.#slider.max;
    if (this.#at >= max) this.#seek(min);
    this.#play.textContent = '❚❚';
    this.#play.setAttribute('aria-label', 'Pause');
    // The whole range in about 30 s; the heatmap eases between steps.
    this.#timer = window.setInterval(() => {
      const t = Math.min(max, this.#at + (max - min) / 120);
      this.#seek(t);
      if (t >= max) this.#pause();
    }, 250);
  }

  #pause(): void {
    clearInterval(this.#timer);
    this.#timer = 0;
    this.#play.textContent = '▶';
    this.#play.setAttribute('aria-label', 'Play');
  }

  close(): void {
    this.#pause();
    this.#load++;
    this.el.remove();
  }
}

export const timeBarStyles = `
  .timebar { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); display: flex;
    align-items: center; gap: 6px; padding: 6px 8px; border-radius: 8px; width: min(640px, calc(100% - 120px));
    box-sizing: border-box; background: color-mix(in srgb, var(--card-background-color, #fff) 92%, transparent);
    box-shadow: 0 1px 6px rgba(0,0,0,0.2); }
  .timebar input { flex: 1; min-width: 60px; }
  .timebar .when { min-width: 5.5em; font-size: 0.85rem; font-variant-numeric: tabular-nums; }
  .timebar .play { width: 36px; }
`;
