// Static SVG for a plan: walls with their openings cut out, doors with their swing, windows, room
// names and areas, and source markers. Pure string output so it runs in Node (docs preview) as
// well as in the browser. Only type imports, so Node can load this file with type stripping.
import type { Door, Opening, Plan, Point, Room, Wall } from './plan';

export interface PlanSvgOptions {
  /** Pixels per metre in the SVG's own units. */
  scale?: number;
  /** Margin around the outline, in metres. */
  margin?: number;
  /** Draw source markers. */
  sources?: boolean;
  /** Accessible title; defaults to the plan name. */
  title?: string;
}

const f = (v: number): string => (Math.round(v * 100) / 100).toString();
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
const length = (a: Point): number => Math.hypot(a[0], a[1]);

function area(polygon: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2);
}

/** A label point inside the room: the bounding-box centre, or the centroid when that falls outside. */
function labelPoint(room: Room): Point {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const c: Point = [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
  return inside(c, room.polygon) ? c : room.polygon[0]!;
}

function inside([x, y]: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The wall's solid pieces between openings, as [from, to] distances from `a`. */
function solidSpans(wall: Wall, openings: readonly Opening[]): [number, number][] {
  const total = length(sub(wall.b, wall.a));
  const gaps = openings
    .filter((o) => o.wall === wall.id)
    .map((o) => [o.offset, o.offset + o.width] as [number, number])
    .sort((p, q) => p[0] - q[0]);
  const spans: [number, number][] = [];
  let at = 0;
  for (const [g0, g1] of gaps) {
    if (g0 > at) spans.push([at, g0]);
    at = Math.max(at, g1);
  }
  if (at < total) spans.push([at, total]);
  return spans;
}

/** Rectangle of a wall piece; ends are extended by half the thickness so corners close. */
function wallRect(
  wall: Wall,
  from: number,
  to: number,
  extendStart: boolean,
  extendEnd: boolean,
): Point[] {
  const d = sub(wall.b, wall.a);
  const u = mul(d, 1 / length(d));
  const n: Point = [-u[1], u[0]];
  const h = wall.thickness / 2;
  const p0 = add(wall.a, mul(u, from - (extendStart ? h : 0)));
  const p1 = add(wall.a, mul(u, to + (extendEnd ? h : 0)));
  return [add(p0, mul(n, h)), add(p1, mul(n, h)), add(p1, mul(n, -h)), add(p0, mul(n, -h))];
}

export function planToSvg(plan: Plan, options: PlanSvgOptions = {}): string {
  const scale = options.scale ?? 60;
  const margin = options.margin ?? 0.5;
  const xs = plan.outline.map((p) => p[0]);
  const ys = plan.outline.map((p) => p[1]);
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const w = Math.max(...xs) + margin - minX;
  const h = Math.max(...ys) + margin - minY;
  const pt = ([x, y]: Point): string => `${f(x)},${f(y)}`;
  const poly = (pts: readonly Point[]): string => pts.map(pt).join(' ');
  const walls = new Map(plan.walls.map((wall) => [wall.id, wall]));
  const openings: Opening[] = [...plan.doors, ...plan.windows];
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(minX)} ${f(minY)} ${f(w)} ${f(h)}" width="${Math.round(w * scale)}" height="${Math.round(h * scale)}" font-family="system-ui, sans-serif">`,
  );
  out.push(`<title>${esc(options.title ?? plan.name)}</title>`);
  out.push(
    '<style>.room{fill:#f6f8fa;stroke:none}.wall{stroke:none}.exterior{fill:#555}.partition{fill:#888}' +
      '.window{fill:#fff;stroke:#555;stroke-width:0.02}.door{fill:none;stroke:#555;stroke-width:0.02}' +
      '.swing{fill:none;stroke:#999;stroke-width:0.015;stroke-dasharray:0.06 0.04}' +
      '.name{font-size:0.32px;fill:#222;text-anchor:middle}.area{font-size:0.24px;fill:#666;text-anchor:middle}' +
      '.source{fill:#03a9f4;stroke:#fff;stroke-width:0.03}</style>',
  );
  out.push(`<rect x="${f(minX)}" y="${f(minY)}" width="${f(w)}" height="${f(h)}" fill="#fff"/>`);

  out.push('<g class="rooms">');
  for (const room of plan.rooms) {
    out.push(`<polygon class="room" data-room="${esc(room.id)}" points="${poly(room.polygon)}"/>`);
  }
  out.push('</g><g class="walls">');
  for (const wall of plan.walls) {
    const total = length(sub(wall.b, wall.a));
    for (const [s0, s1] of solidSpans(wall, openings)) {
      const rect = wallRect(wall, s0, s1, s0 === 0, s1 === total);
      out.push(`<polygon class="wall ${esc(wall.material)}" points="${poly(rect)}"/>`);
    }
  }
  out.push('</g><g class="windows">');
  for (const win of plan.windows) {
    const wall = walls.get(win.wall);
    if (!wall) continue;
    out.push(
      `<polygon class="window" points="${poly(wallRect(wall, win.offset, win.offset + win.width, false, false))}"/>`,
    );
  }
  out.push('</g><g class="doors">');
  for (const door of plan.doors) {
    const wall = walls.get(door.wall);
    if (wall) out.push(doorSvg(wall, door, pt));
  }
  out.push('</g><g class="labels">');
  for (const room of plan.rooms) {
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
        `<circle class="source" cx="${f(s.position[0])}" cy="${f(s.position[1])}" r="0.08"><title>${esc(s.entity_id)}</title></circle>`,
      );
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

/** Door leaf drawn open at 90° into the swing side, plus the dashed swing arc. */
function doorSvg(wall: Wall, door: Door, pt: (p: Point) => string): string {
  const d = sub(wall.b, wall.a);
  const u = mul(d, 1 / length(d));
  // Left normal in y-down space is the side where (b - a) x (p - a) > 0.
  const n: Point = mul([-u[1], u[0]], door.swing);
  const start = add(wall.a, mul(u, door.offset));
  const end = add(wall.a, mul(u, door.offset + door.width));
  const hinge = door.hinge === 'a' ? start : end;
  const free = door.hinge === 'a' ? end : start;
  const face = wall.thickness / 2;
  const hingeFace = add(hinge, mul(n, face));
  const freeFace = add(free, mul(n, face));
  const open = add(hingeFace, mul(n, door.width));
  // Sweep direction: from the closed free edge to the open leaf around the hinge.
  const cross =
    (freeFace[0] - hingeFace[0]) * (open[1] - hingeFace[1]) -
    (freeFace[1] - hingeFace[1]) * (open[0] - hingeFace[0]);
  const sweep = cross > 0 ? 1 : 0;
  const r = f(door.width);
  return (
    `<line class="door" x1="${f(hingeFace[0])}" y1="${f(hingeFace[1])}" x2="${f(open[0])}" y2="${f(open[1])}"/>` +
    `<path class="swing" d="M ${pt(freeFace)} A ${r} ${r} 0 0 ${sweep} ${pt(open)}"/>`
  );
}
