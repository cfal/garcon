import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const requireWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const runtimeRoot = join(dirname(requireWeb.resolve('svelte/package.json')), 'src/internal/client');
const runtimeModule = (path) => import(pathToFileURL(join(runtimeRoot, path)).href);
const { source, set } = await runtimeModule('reactivity/sources.js');
const { derived } = await runtimeModule('reactivity/deriveds.js');
const { effect, effect_root, render_effect } = await runtimeModule('reactivity/effects.js');
const { get, untrack } = await runtimeModule('runtime.js');
const { flushSync } = await runtimeModule('reactivity/batch.js');

describe('Svelte derived reconnection', () => {
  test('connects new deriveds and reconnects unchanged dependencies', () => {
    const count = source(1);
    let value;
    let observed;
    const destroyOwner = effect_root(() => {
      value = derived(() => get(count) * 2);
    });
    try {
      for (let index = 1; index <= 3; index++) {
        const destroyReader = effect_root(() => render_effect(() => { observed = get(value); }));
        try {
          expect(observed).toBe(index * 2);
          expect(count.reactions).toEqual([value]);
          flushSync(() => set(count, index + 1));
          expect(observed).toBe((index + 1) * 2);
        } finally {
          destroyReader();
        }
        expect(count.reactions).toBeNull();
      }
    } finally {
      destroyOwner();
    }
  });

  test('subscribes once to dependencies added while reconnecting and releases them on destroy', () => {
    const selected = source(false);
    const inset = source(202);
    let value;
    let observed;
    const destroyOwner = effect_root(() => {
      value = derived(() => get(selected) ? get(inset) : 0);
      untrack(() => get(value));
    });
    flushSync(() => set(selected, true));
    const destroyReader = effect_root(() => render_effect(() => { observed = get(value); }));
    try {
      expect(observed).toBe(202);
      expect(inset.reactions).toEqual([value]);
      flushSync(() => set(inset, 240));
      expect(observed).toBe(240);
    } finally {
      destroyReader();
      destroyOwner();
    }
    expect(selected.reactions).toBeNull();
    expect(inset.reactions).toBeNull();
  });

  test('does not retain disposed readers across repeated conditional mounts', () => {
    const shared = source(1);
    for (let index = 0; index < 100; index++) {
      const enabled = source(false);
      let value;
      const destroyOwner = effect_root(() => {
        value = derived(() => get(enabled) ? get(shared) : 0);
        untrack(() => get(value));
      });
      flushSync(() => set(enabled, true));
      const destroyReader = effect_root(() => render_effect(() => get(value)));
      destroyReader();
      destroyOwner();
      expect(shared.reactions).toBeNull();
    }
  });

  test('recovers when a newly discovered dependency changes after recalculation throws', () => {
    const enabled = source(false);
    const data = source(0);
    const failure = new Error('temporary');
    let value;
    const observations = [];
    const destroyOwner = effect_root(() => {
      value = derived(() => {
        if (!get(enabled)) return 'inactive';
        if (get(data) === 0) throw failure;
        return `ready:${get(data)}`;
      });
      untrack(() => get(value));
    });
    flushSync(() => set(enabled, true));
    const destroyReader = effect_root(() => render_effect(() => {
      try {
        observations.push(get(value));
      } catch (error) {
        observations.push(error);
      }
    }));
    try {
      expect(observations).toEqual([failure]);
      expect(observations[0]).toBe(failure);
      flushSync(() => set(data, 1));
      expect(observations).toEqual([failure, 'ready:1']);
      expect(data.reactions).toEqual([value]);
    } finally {
      destroyReader();
      destroyOwner();
    }
    expect(enabled.reactions).toBeNull();
    expect(data.reactions).toBeNull();
  });

  test('propagates nested recalculation failures without unfreezing stale child effects', () => {
    const enabled = source(false);
    const data = source(0);
    const failure = new Error('nested derived failure');
    const childFailure = new Error('stale child effect failure');
    let inner;
    let outer;
    let childRuns = 0;
    const observations = [];
    const destroyOwner = effect_root(() => {
      inner = derived(() => {
        if (!get(enabled)) return 3;
        if (get(data) === 0) throw failure;
        return get(data);
      });
      outer = derived(() => {
        effect(() => {
          childRuns++;
          if (childRuns === 2 && get(data) === 0) throw childFailure;
          return () => {};
        });
        return get(inner) * 2;
      });
    });
    try {
      const destroyFirstReader = effect_root(() => render_effect(() => observations.push(get(outer))));
      try {
        flushSync();
        expect(observations).toEqual([6]);
        expect(childRuns).toBe(1);
      } finally {
        destroyFirstReader();
      }

      flushSync(() => set(enabled, true));
      const destroyReader = effect_root(() => render_effect(() => {
        try {
          observations.push(get(outer));
        } catch (error) {
          observations.push(error);
        }
      }));
      try {
        expect(observations).toEqual([6, failure]);
        expect(observations[1]).toBe(failure);
        expect(childRuns).toBe(1);
      } finally {
        destroyReader();
      }
    } finally {
      destroyOwner();
    }
    expect(enabled.reactions).toBeNull();
    expect(data.reactions).toBeNull();
    expect(inner.reactions).toBeNull();
  });

  test('does not resume nested effects after an outer effect fails to unfreeze', () => {
    const count = source(1);
    const outerFailure = new Error('outer child failure');
    const innerFailure = new Error('inner child failure');
    let inner;
    let outer;
    let outerRuns = 0;
    let innerRuns = 0;
    const observations = [];
    const destroyOwner = effect_root(() => {
      inner = derived(() => {
        effect(() => {
          innerRuns++;
          if (innerRuns === 2) throw innerFailure;
          get(count);
          return () => {};
        });
        return get(count);
      });
      outer = derived(() => {
        effect(() => {
          outerRuns++;
          if (outerRuns === 2) throw outerFailure;
          return () => {};
        });
        return get(inner) * 2;
      });
    });
    try {
      const destroyFirstReader = effect_root(() => render_effect(() => observations.push(get(outer))));
      try {
        flushSync();
        expect(observations).toEqual([2]);
        expect(outerRuns).toBe(1);
        expect(innerRuns).toBe(1);
      } finally {
        destroyFirstReader();
      }

      const destroyReader = effect_root(() => render_effect(() => {
        try {
          observations.push(get(outer));
        } catch (error) {
          observations.push(error);
        }
      }));
      try {
        expect(observations).toEqual([2, outerFailure]);
        expect(observations[1]).toBe(outerFailure);
        expect(outerRuns).toBe(2);
        expect(innerRuns).toBe(1);
        expect(count.reactions).toBeNull();
      } finally {
        destroyReader();
      }
    } finally {
      destroyOwner();
    }
    expect(count.reactions).toBeNull();
    expect(inner.reactions).toBeNull();
  });

  test('reconnects a changed transitive graph and preserves other readers', () => {
    const enabled = source(false);
    const shared = source(1);
    const previous = source(10);
    let inner;
    let outer;
    let observed;
    let otherObserved;
    const destroyOther = effect_root(() => render_effect(() => { otherObserved = get(shared); }));
    const destroyOwner = effect_root(() => {
      inner = derived(() => get(shared) * 2);
      outer = derived(() => get(enabled) ? get(inner) : get(previous));
      untrack(() => get(outer));
    });
    try {
      flushSync(() => set(enabled, true));
      const destroyReader = effect_root(() => render_effect(() => { observed = get(outer); }));
      try {
        expect(observed).toBe(2);
        expect(inner.reactions).toEqual([outer]);
        expect(shared.reactions).toHaveLength(2);
        expect(previous.reactions).toBeNull();
        flushSync(() => set(shared, 3));
        expect(observed).toBe(6);
        expect(otherObserved).toBe(3);
      } finally {
        destroyReader();
      }
      expect(inner.reactions).toBeNull();
      expect(enabled.reactions).toBeNull();
      expect(shared.reactions).toHaveLength(1);
      flushSync(() => set(shared, 4));
      expect(otherObserved).toBe(4);
    } finally {
      destroyOwner();
      destroyOther();
    }
    expect(shared.reactions).toBeNull();
  });
});
