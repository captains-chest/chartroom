// The layer buttons shared by the panel and the card: the heatmaps (Temperature, Humidity,
// Signal), one at a time, pressing the active one turns it off; and Mesh, on or off by itself.
import { HEAT_LAYERS, LAYERS, type HeatLayerId } from './heat';
import { button, h } from './ui';

export class LayerToggles {
  readonly el: HTMLElement;
  #buttons = new Map<HeatLayerId, HTMLButtonElement>();
  #active: HeatLayerId | null = null;
  readonly mesh: HTMLButtonElement;

  constructor(onPick: (layer: HeatLayerId | null) => void, onMesh: (on: boolean) => void) {
    this.el = h('div', { class: 'heat-layers', role: 'group', 'aria-label': 'Heatmap layers' });
    for (const id of HEAT_LAYERS) {
      const b = button(LAYERS[id].label, () => onPick(this.#active === id ? null : id), {
        'data-layer': id,
        'aria-pressed': 'false',
      });
      this.#buttons.set(id, b);
      this.el.append(b);
    }
    this.mesh = button('Mesh', () => onMesh(this.mesh.getAttribute('aria-pressed') !== 'true'), {
      'data-layer': 'mesh',
      'aria-pressed': 'false',
      title: 'Zigbee and Z-Wave mesh links',
    });
    this.el.append(this.mesh);
  }

  setMesh(on: boolean): void {
    this.mesh.setAttribute('aria-pressed', String(on));
  }

  /** Mark the active layer; disable layers without a placed sensor. */
  update(active: HeatLayerId | null, counts: Record<HeatLayerId, number>): void {
    this.#active = active;
    for (const [id, b] of this.#buttons) {
      b.setAttribute('aria-pressed', String(id === active));
      b.disabled = counts[id] === 0 && id !== active;
      const what = id === 'signal' ? 'access point or radio' : 'sensor';
      b.title =
        counts[id] === 0
          ? id === 'signal'
            ? 'No access points or radios placed on this plan'
            : `No ${LAYERS[id].label.toLowerCase()} sensors placed on this plan`
          : `${LAYERS[id].label} heatmap (${counts[id]} ${what}${counts[id] === 1 ? '' : 's'})`;
    }
  }
}
