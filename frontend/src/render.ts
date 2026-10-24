import type { FloorGroup } from './model';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An empty plan: a framed SVG with a hint, until Phase 1 brings the editor. */
export function placeholderPlan(label: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 400 240');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.classList.add('plan');
  const frame = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: 8, y: 8, width: 384, height: 224, rx: 6 })) {
    frame.setAttribute(k, String(v));
  }
  frame.classList.add('frame');
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', '200');
  text.setAttribute('y', '124');
  text.setAttribute('text-anchor', 'middle');
  text.textContent = label;
  svg.append(frame, text);
  return svg;
}

/** A list of floors with their areas. Text only, never HTML, so names cannot inject markup. */
export function floorList(groups: FloorGroup[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'floors';
  if (groups.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No floors or areas in Home Assistant yet.';
    root.append(p);
    return root;
  }
  for (const g of groups) {
    const section = document.createElement('section');
    section.dataset.floor = g.id ?? '';
    const h = document.createElement('h3');
    h.textContent = g.name;
    const ul = document.createElement('ul');
    for (const a of g.areas) {
      const li = document.createElement('li');
      li.dataset.area = a.area_id;
      li.textContent = a.name;
      ul.append(li);
    }
    section.append(h, ul);
    root.append(section);
  }
  return root;
}

export const baseStyles = `
  :host { display: block; color: var(--primary-text-color, #212121); font-family: var(--ha-font-family-body, system-ui, sans-serif); }
  .plan { width: 100%; height: auto; display: block; }
  .plan .frame { fill: var(--secondary-background-color, #f5f5f5); stroke: var(--divider-color, #bdbdbd); stroke-width: 2; stroke-dasharray: 6 4; }
  .plan text { fill: var(--secondary-text-color, #727272); font-size: 14px; }
  .floors h3 { margin: 12px 0 4px; font-size: 1rem; }
  .floors ul { margin: 0; padding-left: 20px; }
`;
