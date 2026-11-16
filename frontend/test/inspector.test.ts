import { describe, expect, it, vi } from 'vite-plus/test';
import { Inspector, type Part } from '../src/editor/inspector';
import { installFakeDom } from './fake-dom';

installFakeDom();

const part = (
  key: string,
  deps: unknown[],
  build = vi.fn((): HTMLElement | null => document.createElement('section')),
): Part & { build: typeof build } => ({ key, deps, build });

describe('keyed inspector', () => {
  it('builds each part once while its deps stay the same, in order', () => {
    const el = document.createElement('div');
    const inspector = new Inspector(el);
    const a = part('a', [1]);
    const b = part('b', ['x']);
    inspector.render([a, b]);
    const [na, nb] = el.children;
    const replace = vi.spyOn(el, 'replaceChildren');

    inspector.render([part('a', [1], a.build), part('b', ['x'], b.build)]);
    expect(a.build).toHaveBeenCalledOnce();
    expect(b.build).toHaveBeenCalledOnce();
    // Nothing moved: the elements were not even put back.
    expect(replace).not.toHaveBeenCalled();

    const b2 = part('b', ['y']);
    inspector.render([part('a', [1], a.build), b2]);
    expect(a.build).toHaveBeenCalledOnce();
    expect(b2.build).toHaveBeenCalledOnce();
    expect(el.children[0]).toBe(na);
    expect(el.children[1]).not.toBe(nb);
  });

  it('drops parts that are gone and builds them again when they come back', () => {
    const el = document.createElement('div');
    const inspector = new Inspector(el);
    const a = part('a', []);
    inspector.render([a]);
    inspector.render([]);
    expect(el.children).toHaveLength(0);
    inspector.render([part('a', [], a.build)]);
    expect(a.build).toHaveBeenCalledTimes(2);
  });

  it('leaves out a part that builds nothing', () => {
    const el = document.createElement('div');
    new Inspector(el).render([
      part(
        'a',
        [],
        vi.fn((): HTMLElement | null => null),
      ),
      part('b', []),
    ]);
    expect(el.children).toHaveLength(1);
  });
});
