// The heatmap legend: the layer's ramp and range, ticks at the lowest and highest reading, and a
// note on what feeds the field. Worked out by a pure function, then put into the legend element.
import { LAYERS, rampCss, type LayerData } from '../heat';
import {
  MAX_SIGNAL_SEGMENTS,
  MAX_SIGNAL_SOURCES,
  SEG,
  SRC,
  type CappedSignalInput,
} from '../signal';
import { count, h } from '../ui';
import type { LegendContent } from './models';

/** The signal legend's note: sources and wall segments used, and any the limits left out. */
export function signalNote(input: CappedSignalInput): string[] {
  const sources = input.aps.length / SRC;
  const { leftOut } = input;
  return [
    sources ? count(sources, 'source') : 'No sources',
    count(input.walls.length / SEG, 'wall segment'),
    ...(leftOut.sources
      ? [`${count(leftOut.sources, 'source')} left out (limit ${MAX_SIGNAL_SOURCES})`]
      : []),
    ...(leftOut.segments
      ? [`${count(leftOut.segments, 'wall segment')} left out (limit ${MAX_SIGNAL_SEGMENTS})`]
      : []),
  ];
}

/** The legend for `data` over `domain`; `signalNote` is the signal layer's note (signalNote). */
export function legendContent(
  data: LayerData,
  domain: readonly [number, number],
  signalNote: readonly string[] = [],
): LegendContent {
  const spec = LAYERS[data.layer];
  const { unit } = data;
  const vals = data.readings.map((r) => r.value);
  const n = vals.length;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const fmt = (v: number): string => v.toFixed(spec.digits);
  const pos = (v: number): string =>
    `${(((v - domain[0]) / (domain[1] - domain[0])) * 100).toFixed(1)}%`;
  const signal = data.layer === 'signal';
  const note = signal
    ? [...signalNote]
    : n
      ? [`${fmt(lo)}–${fmt(hi)} ${unit}`, count(n, 'sensor')]
      : ['No readings'];
  if (data.excluded.length) note.push(`${data.excluded.length} left out`);
  return {
    title: spec.label,
    unit,
    ramp: rampCss(spec.ramp),
    ticks:
      n && !signal
        ? [
            { cls: 'min', left: pos(lo), title: `Lowest reading ${fmt(lo)} ${unit}` },
            { cls: 'max', left: pos(hi), title: `Highest reading ${fmt(hi)} ${unit}` },
          ]
        : [],
    scale: [domain[0], (domain[0] + domain[1]) / 2, domain[1]].map(fmt),
    note,
    label: `${spec.label} ${fmt(domain[0])} to ${fmt(domain[1])} ${unit}. ${note.join(', ')}`,
  };
}

export function renderLegend(el: HTMLElement, c: LegendContent): void {
  const bar = h('div', { class: 'heat-bar' });
  bar.style.background = c.ramp;
  for (const t of c.ticks) {
    const tick = h('i', { class: `heat-tick ${t.cls}`, title: t.title });
    tick.style.left = t.left;
    bar.append(tick);
  }
  el.replaceChildren(
    h('div', { class: 'heat-title' }, `${c.title} `, h('span', {}, c.unit)),
    bar,
    h('div', { class: 'heat-scale' }, ...c.scale.map((v) => h('span', {}, v))),
    h('div', { class: 'heat-note' }, c.note.join(' · ')),
  );
  el.setAttribute('aria-label', c.label);
  el.hidden = false;
}
