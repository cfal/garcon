import { selectPrioritizedProjection } from '../../../../common/transcript-projection.ts';

const cost = (text: string) => text.length;
const entry = (level: number, turn: number, text: string) => ({ level, turn, text });
type Entry = ReturnType<typeof entry>;

function fixture(
  entries: Entry[], turnCount: number, maximumCost: number, truncationMarkerCost: number,
  recentTurnsVerbatim?: number, order = entries.map((_entry, index) => index),
) {
  const refittable = entries.map((value) => ({
    ...value,
    refit(maximum: number, measure: typeof cost) {
      let fitted = value.text;
      while (fitted && measure(fitted) > maximum) fitted = fitted.slice(0, -1);
      return fitted;
    },
  }));
  const result = selectPrioritizedProjection({
    entries: order.map((index) => refittable[index]),
    turnCount, maximumCost, truncationMarkerCost, recentTurnsVerbatim, cost,
  });
  return {
    entries, order, turnCount, maximumCost, truncationMarkerCost, recentTurnsVerbatim,
    result: JSON.stringify({ ...result, selected: result.selected.map(({ text }) => text) }),
  };
}

console.log(JSON.stringify([
  fixture([entry(1, 0, 'a0'), ...Array.from({ length: 6 }, (_, turn) => [entry(0, turn, `u${turn}`), entry(4, turn, `t${turn}`)]).flat()], 6, 18, 0),
  fixture(Array.from({ length: 8 }, (_, turn) => entry(0, turn, `request-${turn}`)), 8, 18, 0, 0),
  fixture([entry(0, 0, 'ask'), entry(1, 0, 'old-assistant'), entry(2, 0, 'read'), entry(1, 1, 'new-assistant')], 2, 16, 0, 0),
  fixture([entry(5, 0, 'latest-long-entry')], 1, 6, 1, 0),
  fixture([entry(0, 0, 'same'), entry(0, 0, 'same')], 1, 4, 0, 0, [0, 1, 0]),
  fixture([entry(0, 0, 'ask'), entry(2, 0, '\u{1f600}')], 1, 5, 0, 0),
  fixture([], 0, 0, 1),
  fixture([entry(0, 0, 'ask')], 1, 0, 1),
]));
