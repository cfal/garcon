import { expect, test } from 'bun:test';
import { compareScenario, renderReport, replaySummary } from '../report.js';

test('names the scenarios that were never recorded, which also fail a replay', () => {
  const recorded = compareScenario({ scenario: 'recorded', cases: [{ name: 'ok', expected: 1, noise: [] }] },
    [{ name: 'ok', capture: 1, fallbacks: [] }], 'recorded');
  const missing = compareScenario(null, [], 'never-recorded');
  const summary = replaySummary([recorded, missing], renderReport('original', [recorded, missing], false));
  expect(summary.split('\n').at(-1)).toBe('Never recorded: never-recorded');
});

test('names each failing case with its first difference', () => {
  const golden = { scenario: 's', cases: [{ name: 'differs', expected: { a: 1 }, noise: [] }] };
  const result = compareScenario(golden, [{ name: 'differs', capture: { a: 2 }, fallbacks: [] }], 's');
  expect(replaySummary([result], renderReport('original', [result], false)).split('\n').at(-1))
    .toBe('FAIL s/differs at $.a: expected 1, got 2');
});

test('fails a generated case that was never recorded', () => {
  const golden = { scenario: 's', cases: [{ name: 'recorded', expected: 1, noise: [] }] };
  const runs = [
    { name: 'recorded', capture: 1, fallbacks: [] },
    { name: 'added-later', capture: 2, fallbacks: [] },
  ];
  const result = compareScenario(golden, runs, 's');
  expect(result.cases.map((entry) => [entry.name, entry.difference?.kind ?? null])).toEqual([
    ['recorded', null],
    ['added-later', 'extra'],
  ]);
});
