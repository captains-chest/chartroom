// Bundle-size budget: fails CI when the built frontend grows past the limits below.
// Budgets are for gzip size (what browsers download); raw size is printed for reference.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'custom_components/chartroom/frontend';
const BUDGET = {
  total: 68 * 1024, // every .js file the integration serves (50 KB before multi-area rooms and plan import/export, 53 KB before the separate underlay file, 54 KB before the ignored-underlay notice, 54.5 KB before saying why an imported image was rejected and retrying failed saves, 55 KB before waiting for an image upload at Done, 56 KB before checking stored plans against the plan schema, 57 KB before following plans saved elsewhere in the panel, 58 KB before one marker per Home Assistant device, 60 KB before the device popover, 61 KB before the device radial menu, 64 KB before picking a menu item by a hold slid to it, 64.5 KB before Thread links from Matter, 65 KB before mesh routes and router rings, 66 KB before the signal map from mesh routers fitted to their measured links)
  // The card entry plus the chunks it imports loads on every dashboard (20 KB before the device
  // radial menu, whose own code loads on first use; 20.5 KB before the popover's measured links
  // and the Signal button counting devices as possible mesh routers; 20.6 KB before fitting the
  // plan clear of the legend).
  'chartroom-card.js': 20.8 * 1024,
};

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
walk(DIST);
if (files.length === 0) {
  console.error(`No built JS in ${DIST}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const size = (p) => {
  const buf = readFileSync(p);
  return { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
};
const kb = (n) => `${(n / 1024).toFixed(2)} KB`;

const sizes = new Map(files.map((p) => [relative(DIST, p), size(p)]));
// The card's own weight: its entry plus every chunk it imports statically.
const importsOf = (rel) =>
  [...readFileSync(join(DIST, rel), 'utf8').matchAll(/from"\.\/(chunks\/[\w.-]+\.js)"/g)].map(
    (m) => m[1],
  );
const cardFiles = ['chartroom-card.js', ...importsOf('chartroom-card.js')];
const card = cardFiles.reduce((n, f) => n + (sizes.get(f)?.gzip ?? 0), 0);
const total = [...sizes.values()].reduce((n, s) => n + s.gzip, 0);

for (const [f, s] of sizes)
  console.log(`${f.padEnd(28)} ${kb(s.raw).padStart(10)} raw ${kb(s.gzip).padStart(10)} gzip`);
console.log(
  `card (${cardFiles.join(' + ')}): ${kb(card)} gzip, budget ${kb(BUDGET['chartroom-card.js'])}`,
);
console.log(`total: ${kb(total)} gzip, budget ${kb(BUDGET.total)}`);

let failed = false;
// The worker is a build entry sharing chunks with the page: none of them may touch the DOM.
const workerFiles = new Set();
const follow = (rel) => {
  if (workerFiles.has(rel)) return;
  workerFiles.add(rel);
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  for (const m of readFileSync(join(DIST, rel), 'utf8').matchAll(/from"(\.\.?\/[\w./-]+\.js)"/g))
    follow(relative(DIST, join(DIST, dir, m[1])));
};
follow('workers/worker.js');
for (const f of workerFiles)
  if (/\b(document|customElements|HTMLElement|window)\b/.test(readFileSync(join(DIST, f), 'utf8')))
    failed = (console.error(`${f} is loaded by the worker but uses the DOM.`), true);
console.log(`worker loads: ${[...workerFiles].join(', ')}`);
if (card > BUDGET['chartroom-card.js']) failed = (console.error('Card is over budget.'), true);
if (total > BUDGET.total) failed = (console.error('Total frontend is over budget.'), true);
process.exit(failed ? 1 : 0);
