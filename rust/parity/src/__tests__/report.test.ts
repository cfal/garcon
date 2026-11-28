import { expect, test } from 'bun:test';
import { parseKnownDifferences } from '../known-differences.js';
import { compareScenario, renderReport, replayPassed, replaySummary } from '../report.js';

test('names the scenarios that were never recorded, which also fail a replay', () => {
  const recorded = compareScenario({ scenario: 'recorded', cases: [{ name: 'ok', expected: 1, noise: [] }] },
    [{ name: 'ok', capture: 1, fallbacks: [] }], 'recorded');
  const missing = compareScenario(null, [], 'never-recorded');
  const summary = replaySummary([recorded, missing], renderReport('original', [recorded, missing], false));
  expect(summary.split('\n').at(-1)).toBe('Never recorded: never-recorded');
});

test('a marked response does not consume a known difference or count as a native match', () => {
  const golden = { scenario: 's', cases: [
    { name: 'implemented', expected: { status: 200 }, noise: [] },
    { name: 'fallback', expected: { status: 200 }, noise: [] },
    { name: 'unported', expected: { status: 200 }, noise: [] },
  ] };
  const known = parseKnownDifferences([
    { scenario: 's', case: 'unported', path: '$.status', result: 404, reason: 'synthetic known difference' },
  ]);
  const result = compareScenario(golden, [
    { name: 'implemented', capture: { status: 200 }, fallbacks: [] },
    { name: 'fallback', capture: { status: 200 }, fallbacks: ['GET /fallback'] },
    { name: 'unported', capture: { status: 501 }, fallbacks: [], unavailable: { kind: 'unported' } },
  ], 's', known);
  expect(result.cases[2]).toMatchObject({ difference: null, native: false, unavailable: { kind: 'unported' } });
  expect(replayPassed([result])).toBe(false);
  expect(replayPassed([result], true)).toBe(true);
  const report = renderReport('native', [result], true);
  expect(report).toContain('Matched via fallback: 1/3 cases');
  expect(report).toContain('| s | 2/3 | 1/3 | 1 | 0 | 0 |');
  expect(report).toContain('- s/unported: unported');
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
