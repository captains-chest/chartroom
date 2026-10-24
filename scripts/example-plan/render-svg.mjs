// Renders the example-plan fixture to docs/images/example-plan.svg. Generated only from the fixture
// geometry, so the preview contains nothing from the original drawing.
// Run: node scripts/example-plan/render-svg.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { planToSvg } from '../../frontend/src/plan-svg.ts';

const FIXTURE = 'frontend/test/fixtures/example-plan.json';
const OUT = 'docs/images/example-plan.svg';

const plan = JSON.parse(readFileSync(FIXTURE, 'utf8'));
writeFileSync(OUT, planToSvg(plan));
console.log(`wrote ${OUT}`);
