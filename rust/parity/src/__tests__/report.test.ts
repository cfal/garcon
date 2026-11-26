import { expect, test } from 'bun:test';
import { compareScenario } from '../report.js';

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
