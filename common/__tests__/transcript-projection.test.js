import { describe, expect, test } from 'bun:test';
import { selectPrioritizedProjection } from '../transcript-projection.ts';

const cost = (text) => text.length;

function entry(level, turn, text) {
  return {
    level,
    turn,
    text,
    refit: (maximumCost, measure) => {
      let fitted = text;
      while (fitted && measure(fitted) > maximumCost) fitted = fitted.slice(0, -1);
      return fitted;
    },
  };
}

describe('prioritized transcript projection', () => {
  test('admits asks before tools and pins the newest three turns whole', () => {
    const entries = [];
    for (let turn = 0; turn < 6; turn += 1) {
      entries.push(entry(0, turn, `u${turn}`));
      entries.push(entry(4, turn, `t${turn}`));
    }

    const result = selectPrioritizedProjection({
      entries,
      turnCount: 6,
      maximumCost: 18,
      truncationMarkerCost: 0,
      cost,
      recentTurnsVerbatim: 3,
    });

    expect(result.selected.map((value) => value.text)).toEqual([
      'u0', 'u1', 'u2', 'u3', 't3', 'u4', 't4', 'u5', 't5',
    ]);
    expect(result.truncated).toBeTrue();
  });

  test('protects the newest and oldest asks when asks alone overflow', () => {
    const entries = Array.from({ length: 8 }, (_, turn) => entry(0, turn, `request-${turn}`));
    const result = selectPrioritizedProjection({
      entries,
      turnCount: 8,
      maximumCost: 18,
      truncationMarkerCost: 0,
      cost,
      recentTurnsVerbatim: 0,
    });

    expect(result.selected.map((value) => value.text)).toEqual(['request-0', 'request-7']);
  });

  test('stops at the first incomplete priority level and preserves source order', () => {
    const entries = [
      entry(0, 0, 'ask'),
      entry(1, 0, 'old-assistant'),
      entry(2, 0, 'read'),
      entry(1, 1, 'new-assistant'),
    ];
    const result = selectPrioritizedProjection({
      entries,
      turnCount: 2,
      maximumCost: 16,
      truncationMarkerCost: 0,
      cost,
      recentTurnsVerbatim: 0,
    });

    expect(result.selected.map((value) => value.text)).toEqual(['ask', 'new-assistant']);
    expect(result.selected.map((value) => value.text)).not.toContain('read');
  });

  test('refits the latest entry when no complete entry fits', () => {
    const result = selectPrioritizedProjection({
      entries: [entry(5, 0, 'latest-long-entry')],
      turnCount: 1,
      maximumCost: 6,
      truncationMarkerCost: 1,
      cost,
      recentTurnsVerbatim: 0,
    });

    expect(result.selected.map((value) => value.text)).toEqual(['lates']);
  });
});
