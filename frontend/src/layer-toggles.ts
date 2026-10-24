// The heatmap layer buttons (Temperature, Humidity) shared by the panel and the card. One layer
// at a time; pressing the active one turns the heatmap off.
import { HEAT_LAYERS, LAYERS, type HeatLayerId } from './heat';
import { button, h } from './ui';

export class LayerToggles {
  readonly el: HTMLElement;
  #buttons = new Map<HeatLayerId, HTMLButtonElement>();
  #active: HeatLayerId | null = null;

  constructor(onPick: (layer: HeatLayerId | null) => void) {
    this.el = h('div', { class: 'heat-layers', role: 'group', 'aria-label': 'Heatmap layers' });
    for (const id of HEAT_LAYERS) {
      const b = button(LAYERS[id].label, () => onPick(this.#active === id ? null : id), {
        'data-layer': id,
        'aria-pressed': 'false',
      });
      this.#buttons.set(id, b);
      this.el.append(b);
    }
  }

  /** Mark the active layer; disable layers without a placed sensor. */
  update(active: HeatLayerId | null, counts: Record<HeatLayerId, number>): void {
    this.#active = active;
    for (const [id, b] of this.#buttons) {
      b.setAttribute('aria-pressed', String(id === active));
      b.disabled = counts[id] === 0 && id !== active;
      b.title =
        counts[id] === 0
          ? `No ${LAYERS[id].label.toLowerCase()} sensors placed on this plan`
          : `${LAYERS[id].label} heatmap (${counts[id]} sensor${counts[id] === 1 ? '' : 's'})`;
    }
  }
}
