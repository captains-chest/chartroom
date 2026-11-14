import { describe, expect, it, vi } from 'vite-plus/test';
import { emptyPlan } from '../src/plan/functions';
import type { Plan } from '../src/plan/models';
import { PlanEditor } from '../src/plan-editor';
import { PlanView } from '../src/plan-view';
import { installFakeDom } from './fake-dom';

vi.mock('../src/heat-layer', () => ({
  HeatLayer: class {
    dispose = vi.fn();
    setLayer = vi.fn();
    setView = vi.fn();
    setHass = vi.fn();
    setPlan = vi.fn();
    onReadings = null;
  },
  renderValueLabels: () => {},
  declutterLabels: () => {},
}));

installFakeDom();

type Node = { children?: (Node | string)[]; getAttribute?(k: string): string | null };

/** The text under the inspector's ignored-underlay hint, or null when there is none. */
function ignoredHint(el: Node): string | null {
  if (el.getAttribute?.('data-hint') === 'underlay-ignored')
    return el.children!.filter((c) => typeof c === 'string').join('');
  for (const c of el.children ?? []) {
    if (typeof c === 'string') continue;
    const t = ignoredHint(c);
    if (t !== null) return t;
  }
  return null;
}

function editor(plan: Plan, underlayIgnored?: boolean): PlanEditor {
  const view = new PlanView(true);
  view.setPlan(plan);
  return new PlanEditor({
    view,
    hass: () => undefined,
    save: async () => {},
    planId: 'home',
    plan,
    underlayIgnored,
  });
}

describe('editor underlay panel', () => {
  it('tells the admin when the stored underlay was ignored, until an image is back', () => {
    const plan = emptyPlan('Home');
    expect(ignoredHint(editor(plan, true).inspector as unknown as Node)).toMatch(
      /pointed outside Chartroom.*Import the image again/,
    );
    expect(ignoredHint(editor(plan).inspector as unknown as Node)).toBeNull();
    const own: Plan = {
      ...plan,
      underlay: {
        url: '/api/chartroom/underlay/home',
        width_px: 100,
        height_px: 50,
        scale: 0.05,
        origin: [0, 0],
        opacity: 0.5,
      },
    };
    expect(ignoredHint(editor(own, true).inspector as unknown as Node)).toBeNull();
  });
});
