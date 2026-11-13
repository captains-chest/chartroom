// Builds frontend/test/fixtures/example-plan.json: a one-floor flat of about 62 m², traced by hand
// from a 300 dpi architectural drawing. The drawing itself is not in the repository; only the
// geometry below (pixel measurements of wall faces, door and window gaps) and generic room types
// are.
//
// Scale: one px-per-metre factor, fitted so the traced room areas match the drawing's stated room
// areas with the least squared relative error. Everything is then converted to metres with the
// origin at the top-left of the outline.
//
// Run: node scripts/example-plan/trace.mjs   (then: node scripts/example-plan/render-svg.mjs)
import { writeFileSync } from 'node:fs';

const OUT = 'frontend/test/fixtures/example-plan.json';

// --- Pixel measurements (x right, y down) ---------------------------------------------------------

const ORIGIN = [39, 49]; // outer top-left corner of the envelope

// Rooms: inner wall faces. `area` is the stated area on the drawing, in m².
const ROOMS = [
  {
    id: 'bedroom_1',
    name: 'Bedroom 1',
    area: 11.3,
    px: [
      [74, 140],
      [625, 140],
      [625, 829],
      [74, 829],
    ],
  },
  {
    id: 'kitchen_living',
    name: 'Kitchen-living',
    area: 31.1,
    // Open to the hall below the bath; the boundary continues the west face of the partition.
    px: [
      [641, 140],
      [1390, 140],
      [1390, 1542],
      [625, 1542],
      [625, 1246],
      [641, 1246],
    ],
  },
  {
    id: 'bath',
    name: 'Bath',
    area: 4.9,
    px: [
      [183, 845],
      [625, 845],
      [625, 1232],
      [183, 1232],
    ],
  },
  {
    id: 'hall',
    name: 'Hall',
    area: 4.2,
    px: [
      [74, 1246],
      [625, 1246],
      [625, 1542],
      [209, 1542],
      [209, 1404],
      [74, 1404],
    ],
  },
  {
    id: 'bedroom_2',
    name: 'Bedroom 2',
    area: 10.3,
    px: [
      [1425, 918],
      [1981, 918],
      [1981, 1542],
      [1425, 1542],
    ],
  },
];

// Outer faces of the envelope, clockwise from the top-left.
const OUTLINE = [
  [39, 49],
  [1482, 49],
  [1482, 826],
  [2015, 826],
  [2015, 1575],
  [194, 1575],
  [194, 1420],
  [39, 1420],
];

// Walls: centrelines and full thickness, in px. Outer walls are exterior masonry/concrete; inner
// walls are light partitions.
const WALLS = [
  // Envelope, clockwise.
  { id: 'ext_north', a: [56.5, 94.5], b: [1436, 94.5], t: 91, material: 'exterior' },
  { id: 'ext_east', a: [1436, 94.5], b: [1436, 872], t: 92, material: 'exterior' },
  { id: 'ext_north_2', a: [1436, 872], b: [1998, 872], t: 92, material: 'exterior' },
  { id: 'ext_east_2', a: [1998, 872], b: [1998, 1558.5], t: 34, material: 'exterior' },
  { id: 'ext_south', a: [1998, 1558.5], b: [201.5, 1558.5], t: 33, material: 'exterior' },
  { id: 'ext_entry_west', a: [201.5, 1558.5], b: [201.5, 1412], t: 15, material: 'exterior' },
  { id: 'ext_entry_step', a: [201.5, 1412], b: [56.5, 1412], t: 16, material: 'exterior' },
  { id: 'ext_west', a: [56.5, 1412], b: [56.5, 94.5], t: 35, material: 'exterior' },
  // Partitions.
  { id: 'int_bedroom_1_east', a: [633, 140], b: [633, 1246], t: 16, material: 'partition' },
  { id: 'int_bedroom_1_south', a: [74, 837], b: [625, 837], t: 16, material: 'partition' },
  { id: 'int_bath_south', a: [74, 1239], b: [625, 1239], t: 14, material: 'partition' },
  { id: 'int_bath_closet', a: [175, 845], b: [175, 1232], t: 16, material: 'partition' },
  { id: 'int_bath_shower', a: [183, 1103], b: [301, 1103], t: 16, material: 'partition' },
  { id: 'int_bath_stub_north', a: [449, 845], b: [449, 900], t: 16, material: 'partition' },
  { id: 'int_bath_stub_east', a: [570, 1019], b: [625, 1019], t: 16, material: 'partition' },
  { id: 'int_bedroom_2_west', a: [1407.5, 918], b: [1407.5, 1542], t: 35, material: 'partition' },
];

// Openings: start and end along the wall's main axis, in px.
const DOORS = [
  // Hinge and swing read off the door arcs.
  {
    id: 'door_bedroom_1',
    wall: 'int_bedroom_1_east',
    from: 541,
    to: 711,
    hinge: 'b',
    into: 'bedroom_1',
  },
  {
    id: 'door_bedroom_2',
    wall: 'int_bedroom_2_west',
    from: 935,
    to: 1104,
    hinge: 'a',
    into: 'bedroom_2',
  },
  { id: 'door_bath', wall: 'int_bath_south', from: 326, to: 497, hinge: 'a', into: 'bath' },
  {
    id: 'door_entrance',
    wall: 'ext_south',
    from: 331,
    to: 518,
    hinge: 'b',
    into: 'hall',
    exterior: true,
  },
];
const WINDOWS = [
  { id: 'window_bedroom_1', wall: 'ext_north', from: 144, to: 512 },
  { id: 'window_kitchen_north', wall: 'ext_north', from: 725, to: 1092 },
  { id: 'window_kitchen_east', wall: 'ext_east', from: 230, to: 597 },
  { id: 'window_bedroom_2', wall: 'ext_north_2', from: 1482, to: 1794 },
];

// Dev sample data: the simulated rooms of the box development Home Assistant mapped onto this plan,
// with their sensors near the room centres. `at` overrides the centre (fractions of the room's
// bounding box) where two areas share one room.
const SAMPLE = [
  {
    room: 'kitchen_living',
    area: 'living_room',
    entities: ['living_room_temperature', 'living_room_humidity'],
    at: [0.5, 0.3],
  },
  {
    room: 'kitchen_living',
    area: 'kitchen',
    entities: ['kitchen_temperature', 'kitchen_humidity'],
    at: [0.6, 0.72],
  },
  { room: 'bedroom_1', area: 'bedroom', entities: ['bedroom_temperature', 'bedroom_humidity'] },
  {
    room: 'bath',
    area: 'bath',
    entities: ['bath_temperature', 'bath_humidity', 'bath_temperature_2_dead_battery'],
  },
  { room: 'hall', area: 'hall', entities: ['hall_temperature', 'hall_humidity'] },
  { room: 'bedroom_2', area: 'office', entities: ['office_temperature', 'office_humidity'] },
];

// --- Scale fit ----------------------------------------------------------------------------------

const shoelace = (pts) =>
  Math.abs(
    pts.reduce((s, [x1, y1], i) => {
      const [x2, y2] = pts[(i + 1) % pts.length];
      return s + x1 * y2 - x2 * y1;
    }, 0),
  ) / 2;

// Minimise sum(((A_px * u) - A) / A)^2 over u = 1 / scale^2  =>  u = sum(r) / sum(r^2), r = A_px / A.
const ratios = ROOMS.map((r) => shoelace(r.px) / r.area);
const u = ratios.reduce((s, r) => s + r, 0) / ratios.reduce((s, r) => s + r * r, 0);
const PX_PER_M = 1 / Math.sqrt(u);

const mm = (v) => Math.round(v * 1000) / 1000;
const m = ([x, y]) => [mm((x - ORIGIN[0]) / PX_PER_M), mm((y - ORIGIN[1]) / PX_PER_M)];
const len = (v) => mm(v / PX_PER_M);

const walls = WALLS.map((w) => ({
  id: w.id,
  a: m(w.a),
  b: m(w.b),
  thickness: len(w.t),
  material: w.material,
}));
const wallById = new Map(WALLS.map((w) => [w.id, w]));

// Opening offset from the wall's `a` end, along its axis.
const along = (wall, from, to) => {
  const horizontal = wall.a[1] === wall.b[1];
  const a = horizontal ? wall.a[0] : wall.a[1];
  const dir = Math.sign((horizontal ? wall.b[0] : wall.b[1]) - a);
  const d1 = (from - a) * dir;
  const d2 = (to - a) * dir;
  return { offset: len(Math.min(d1, d2)), width: len(Math.abs(d2 - d1)) };
};

const roomPx = new Map(ROOMS.map((r) => [r.id, r.px]));
const centreOf = (pts) => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
];

const doors = DOORS.map((d) => {
  const wall = wallById.get(d.wall);
  // Swing side: sign of (b - a) x (room centre - a).
  const [cx, cy] = centreOf(roomPx.get(d.into));
  const cross =
    (wall.b[0] - wall.a[0]) * (cy - wall.a[1]) - (wall.b[1] - wall.a[1]) * (cx - wall.a[0]);
  return {
    id: d.id,
    wall: d.wall,
    ...along(wall, d.from, d.to),
    material: 'wood_door',
    thickness: d.exterior ? 0.06 : 0.04,
    hinge: d.hinge,
    swing: cross > 0 ? 1 : -1,
  };
});

const windows = WINDOWS.map((w) => ({
  id: w.id,
  wall: w.wall,
  ...along(wallById.get(w.wall), w.from, w.to),
  material: 'glass',
  thickness: 0.024,
}));

const rooms = ROOMS.map((r) => ({
  id: r.id,
  name: r.name,
  polygon: r.px.map(m),
  // Every area sampled in the room: kitchen-living is one open-plan room with two areas.
  area_ids: SAMPLE.filter((s) => s.room === r.id).map((s) => s.area),
}));

const sources = SAMPLE.flatMap((s, i) => {
  const pts = roomPx.get(s.room);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [fx, fy] = s.at ?? [0.5, 0.5];
  const base = s.at
    ? [
        Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * fx,
        Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * fy,
      ]
    : centreOf(pts);
  // Sensors of one area sit side by side, 0.25 m apart, so markers don't overlap.
  return s.entities.map((e, j) => ({
    id: e,
    kind: 'sensor',
    entity_id: `sensor.${e}`,
    position: m([base[0] + (j - (s.entities.length - 1) / 2) * 0.25 * PX_PER_M, base[1]]),
    area_id: s.area,
    order: i,
  }));
}).map(({ order: _order, ...s }) => s);

const plan = {
  schema_version: 1,
  name: 'Example flat (traced fixture)',
  floor_id: null,
  outline: OUTLINE.map(m),
  walls,
  rooms,
  doors,
  windows,
  sources,
  // Not part of the plan model: provenance and the stated areas the fixture test checks against.
  meta: {
    traced_px_per_m: mm(PX_PER_M),
    stated_areas_m2: Object.fromEntries(ROOMS.map((r) => [r.id, r.area])),
    stated_total_m2: 62,
    sample_areas: Object.fromEntries(SAMPLE.map((s) => [s.area, s.room])),
  },
};

writeFileSync(OUT, `${JSON.stringify(plan, null, 2)}\n`);
console.log(`scale ${PX_PER_M.toFixed(2)} px/m -> ${OUT}`);
for (const r of ROOMS) {
  const a = shoelace(r.px) / PX_PER_M ** 2;
  console.log(
    `${r.name.padEnd(15)} stated ${r.area.toFixed(1)}  traced ${a.toFixed(2)}  ${(((a - r.area) / r.area) * 100).toFixed(1)}%`,
  );
}
