import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Locator } from '@playwright/test';
import { deletePlan, savePlan } from './ha';

// Old-wall-tablet check (docs/render-design.md): a synthetic worst case at the soft caps, 512 walls
// and 32 access points, timed on a CPU-throttled page. Opt-in: PERF=1 pnpm e2e e2e/perf.spec.ts
// (optionally PERF_RATES=4,6 and PERF_OUT=file.json). Not part of CI.
const PLAN = 'e2e-perf';
const token = (): string => process.env['HA_TOKEN'] ?? '';
const FIXTURE = JSON.parse(readFileSync('frontend/test/fixtures/example-plan.json', 'utf8'));
const RATES = (process.env['PERF_RATES'] ?? '1,4,6').split(',').map(Number);
const RUNS = 12;
const WALLS = Number(process.env['PERF_WALLS'] ?? 512);
const APS = Number(process.env['PERF_APS'] ?? 32);

type Pt = [number, number];
/** A 16 x 12 m block of 1 m cells: 412 grid walls plus 100 diagonal stubs, and 32 sources. */
function worstCase(): Record<string, unknown> {
  const walls: Record<string, unknown>[] = [];
  const add = (a: Pt, b: Pt, material: string, thickness: number): void => {
    walls.push({ id: `w${walls.length}`, a, b, material, thickness });
  };
  for (let y = 0; y <= 12; y++)
    for (let x = 0; x < 16; x++)
      add([x, y], [x + 1, y], y % 12 ? 'partition' : 'exterior', y % 12 ? 0.1 : 0.3);
  for (let x = 0; x <= 16; x++)
    for (let y = 0; y < 12; y++)
      add([x, y], [x, y + 1], x % 16 ? 'partition' : 'exterior', x % 16 ? 0.1 : 0.3);
  for (let i = 0; walls.length < WALLS; i++) {
    const x = (i * 7) % 16;
    const y = (i * 5) % 12;
    add([x + 0.2, y + 0.2], [x + 0.8, y + 0.8], 'partition', 0.08);
  }
  const sources = Array.from({ length: APS }, (_, i) => ({
    id: `ap${i}`,
    kind: i % 2 ? 'radio' : 'access_point',
    entity_id: '',
    position: [0.5 + ((i * 5) % 16), 0.5 + ((i * 3) % 12)] as Pt,
  }));
  walls.length = Math.min(walls.length, WALLS);
  return {
    ...FIXTURE,
    name: 'E2E perf',
    floor_id: null,
    outline: [
      [0, 0],
      [16, 0],
      [16, 12],
      [0, 12],
    ],
    rooms: [],
    walls,
    doors: [],
    windows: [],
    sources,
    devices: [],
  };
}

interface Timing {
  renderer: string;
  segments: number;
  retraceMs: { median: number; p90: number; max: number };
  frameMs: { median: number; p90: number; fps: number };
}

async function measure(panel: Locator, renderer: 'webgl2' | 'canvas'): Promise<Timing> {
  return panel.evaluate(
    async (el, [renderer, runs]) => {
      type Heat = {
        renderer: string;
        setRenderer(k: string): void;
        setPlan(p: unknown): void;
        idle(): Promise<void>;
        readField(): Promise<unknown>;
        legend: HTMLElement;
      };
      const view = (el as unknown as { view: { heat: Heat; plan: Record<string, unknown> } }).view;
      const heat = view.heat;
      heat.setRenderer(renderer as string);
      await heat.idle();
      const base = view.plan;
      const sources = base['sources'] as { position: [number, number] }[];
      const times: number[] = [];
      for (let i = 0; i <= (runs as number); i++) {
        // Move one access point a little: the whole field is traced again.
        const moved = sources.map((s, j) =>
          j === 0 ? { ...s, position: [s.position[0] + 0.01 * (i + 1), s.position[1]] } : s,
        );
        const t0 = performance.now();
        heat.setPlan({ ...base, sources: moved });
        await heat.idle();
        await heat.readField(); // makes the GPU finish (readPixels)
        if (i) times.push(performance.now() - t0);
      }
      heat.setPlan(base);
      await heat.idle();
      // Pan for a second and time the frames: the field is not traced again, only drawn.
      const svg = el.shadowRoot!.querySelector('svg.plan')!;
      const box = svg.getBoundingClientRect();
      const frames: number[] = [];
      await new Promise<void>((done) => {
        let last = performance.now();
        const end = last + 1500;
        const step = (t: number): void => {
          frames.push(t - last);
          last = t;
          svg.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: frames.length % 20 < 10 ? -40 : 40,
              clientX: box.x + box.width / 2,
              clientY: box.y + box.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
          if (t < end) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      const q = (a: number[], p: number): number =>
        [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
      const note = heat.legend.textContent ?? '';
      return {
        renderer: heat.renderer,
        segments: Number(/(\d+) wall segments/.exec(note)?.[1] ?? 0),
        retraceMs: { median: q(times, 0.5), p90: q(times, 0.9), max: Math.max(...times) },
        frameMs: {
          median: q(frames, 0.5),
          p90: q(frames, 0.9),
          fps: (1000 * frames.length) / frames.reduce((s, f) => s + f, 0),
        },
      };
    },
    [renderer, RUNS] as const,
  );
}

test('old wall tablet: signal at the soft caps, CPU throttled', async ({ page }) => {
  test.skip(!process.env['PERF'], 'set PERF=1 to run the perf check');
  test.setTimeout(10 * 60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await savePlan(token(), PLAN, worstCase());
  const results: Record<string, unknown>[] = [];
  try {
    await page.goto('/chartroom');
    const panel = page.locator('chartroom-panel');
    await panel.locator(`[role=tab][data-plan="${PLAN}"]`).click();
    await expect(panel).toHaveAttribute('data-plan', PLAN);
    await panel.getByRole('button', { name: 'Signal' }).click();
    await expect(panel.locator('.heat-legend')).toContainText(`${APS} sources`);
    const cdp = await page.context().newCDPSession(page);
    for (const rate of RATES) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      for (const r of ['webgl2', 'canvas'] as const) {
        const t = await measure(panel, r);
        if (t.renderer !== r) console.log('renderer fell back', r, '->', t.renderer);
        results.push({ cpuSlowdown: rate, ...t });
        console.log(JSON.stringify({ cpuSlowdown: rate, ...t }));
      }
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas').getContext('webgl2');
      const ext = c?.getExtension('WEBGL_debug_renderer_info');
      return ext ? c!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    console.log('WebGL renderer:', gl);
    if (process.env['PERF_OUT'])
      writeFileSync(process.env['PERF_OUT'], JSON.stringify({ gl, results }, null, 2));
  } finally {
    await page.evaluate(() => localStorage.removeItem('chartroom:layer'));
    await deletePlan(token(), PLAN);
  }
});
