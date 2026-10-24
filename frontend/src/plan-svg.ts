// SVG markup for a plan: walls with their openings cut out, doors with their swing, windows, room
// names and areas, and source markers. Pure string output so it runs in Node (the docs preview) as
// well as in the panel. Every element carries `data-kind` / `data-id` for hit testing. Only type
// imports (plus geometry), so Node can load this file with type stripping.
import { doorGeometry, frame, pointInPolygon, wallPieces, wallRect } from './geometry.ts';
import type { Opening, Plan, Point, Room } from './plan';

export interface PlanSvgOptions {
  /** Pixels per metre for the standalone SVG's width and height. */
  scale?: number;
  /** Margin around the outline, in metres. */
  margin?: number;
  /** Draw source markers. */
  sources?: boolean;
  /** Accessible title; defaults to the plan name. */
  title?: string;
}

const f = (v: number): string => (Math.round(v * 100) / 100).toString();
/** Escapes text and attribute values (all attributes are double-quoted). */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pt = ([x, y]: Point): string => `${f(x)},${f(y)}`;
const poly = (pts: readonly Point[]): string => pts.map(pt).join(' ');

function area(polygon: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

/** A label point inside the room: the bounding-box centre, or a corner when that falls outside. */
export function labelPoint(room: Room): Point {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const c: Point = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  return pointInPolygon(c, room.polygon) ? c : room.polygon[0]!;
}

export const PLAN_STYLE =
  '.room{fill:#f6f8fa;stroke:none}.wall{stroke:none}.exterior{fill:#555}.partition{fill:#888}' +
  '.window{fill:#fff;stroke:#555;stroke-width:0.02}.door{fill:none;stroke:#555;stroke-width:0.02}' +
  '.swing{fill:none;stroke:#999;stroke-width:0.015;stroke-dasharray:0.06 0.04}' +
  '.name{font-size:0.32px;fill:#222;text-anchor:middle}.area{font-size:0.24px;fill:#666;text-anchor:middle}' +
  '.source{fill:#03a9f4;stroke:#fff;stroke-width:0.03}.source.access_point{fill:#ff9800}.source.radio{fill:#9c27b0}';

/** The plan's groups (rooms, walls, windows, doors, labels, sources), without the <svg> wrapper. */
export function planBody(plan: Plan, options: { sources?: boolean } = {}): string {
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const openings: Opening[] = [...plan.doors, ...plan.windows];
  const out: string[] = [];
  const data = (kind: string, id: string): string => `data-kind="${kind}" data-id="${esc(id)}"`;

  out.push('<g class="rooms">');
  for (const room of plan.rooms) {
    out.push(`<polygon class="room" ${data('room', room.id)} points="${poly(room.polygon)}"/>`);
  }
  out.push('</g><g class="walls">');
  for (const wall of plan.walls) {
    for (const piece of wallPieces(wall, openings)) {
      out.push(
        `<polygon class="wall ${esc(wall.material)}" ${data('wall', wall.id)} points="${poly(piece)}"/>`,
      );
    }
  }
  out.push('</g><g class="windows">');
  for (const win of plan.windows) {
    const wall = walls.get(win.wall);
    if (!wall) continue;
    const rect = wallRect(wall, win.offset, win.offset + win.width);
    out.push(`<polygon class="window" ${data('window', win.id)} points="${poly(rect)}"/>`);
  }
  out.push('</g><g class="doors">');
  for (const door of plan.doors) {
    const wall = walls.get(door.wall);
    if (!wall || frame(wall).length === 0) continue;
    const g = doorGeometry(wall, door);
    const r = f(door.width);
    // An invisible hit area over the gap, so the door can be picked in the wall.
    const gap = wallRect(wall, door.offset, door.offset + door.width);
    out.push(
      `<g class="door-group" ${data('door', door.id)}>` +
        `<polygon class="door-gap" points="${poly(gap)}" fill="transparent"/>` +
        `<line class="door" x1="${f(g.hinge[0])}" y1="${f(g.hinge[1])}" x2="${f(g.open[0])}" y2="${f(g.open[1])}"/>` +
        `<path class="swing" d="M ${pt(g.closed)} A ${r} ${r} 0 0 ${g.sweep} ${pt(g.open)}"/></g>`,
    );
  }
  out.push('</g><g class="labels">');
  for (const room of plan.rooms) {
    if (room.polygon.length < 3) continue;
    // Above the centre, where sensors usually sit.
    const [x, cy] = labelPoint(room);
    const y = cy - 0.55;
    out.push(
      `<text class="name" x="${f(x)}" y="${f(y)}">${esc(room.name)}</text>` +
        `<text class="area" x="${f(x)}" y="${f(y + 0.3)}">${area(room.polygon).toFixed(1)} m²</text>`,
    );
  }
  out.push('</g>');
  if (options.sources !== false && plan.sources.length > 0) {
    out.push('<g class="sources">');
    for (const s of plan.sources) {
      out.push(
        `<circle class="source ${esc(s.kind)}" ${data('source', s.id)} cx="${f(s.position[0])}" cy="${f(s.position[1])}" r="0.08"><title>${esc(s.entity_id || 'No entity yet')}</title></circle>`,
      );
    }
    out.push('</g>');
  }
  return out.join('\n');
}

/** A standalone SVG document of the plan (used for the docs preview). */
export function planToSvg(plan: Plan, options: PlanSvgOptions = {}): string {
  const scale = options.scale ?? 60;
  const margin = options.margin ?? 0.5;
  const xs = plan.outline.map((p) => p[0]);
  const ys = plan.outline.map((p) => p[1]);
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const w = Math.max(...xs) + margin - minX;
  const h = Math.max(...ys) + margin - minY;
  return (
    [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(minX)} ${f(minY)} ${f(w)} ${f(h)}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" font-family="system-ui, sans-serif">`,
      `<title>${esc(options.title ?? plan.name)}</title>`,
      `<style>${PLAN_STYLE}</style>`,
      `<rect x="${f(minX)}" y="${f(minY)}" width="${f(w)}" height="${f(h)}" fill="#fff"/>`,
      planBody(plan, options),
      '</svg>',
    ].join('\n') + '\n'
  );
}
