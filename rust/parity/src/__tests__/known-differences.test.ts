import { expect, test } from 'bun:test';
import { compareWithKnown, parseKnownDifferences, scenarioKnownDifferencesForBuild } from '../known-differences.js';
import { compareScenario } from '../report.js';
import { compareTraces, type Traces } from '../traces.js';

const example = { scenario: 'fixture', case: 'sample', path: '$.body.status', result: 'rust-[..]', reason: 'synthetic approval' };

test('only the exact approved value is accepted and unrelated drift still fails', () => {
  const golden = { body: { status: 'original', untouched: true } };
  const approvals = parseKnownDifferences([example]);
  expect(compareWithKnown(golden, { body: { status: 'rust-[..]', untouched: true } }, approvals)).toBeNull();
  expect(compareWithKnown(golden, { body: { status: 'rust-anything', untouched: true } }, approvals)?.path).toBe('$.body.status');
  expect(compareWithKnown(golden, { body: { status: 'rust-[..]', untouched: false } }, approvals)?.path).toBe('$.body.untouched');
  expect(compareWithKnown(golden, golden, approvals)).toMatchObject({
    path: '$.body.status', actual: 'matches the original recording',
  });
  expect(compareWithKnown({ body: '[..]' }, { body: { status: 'rust-[..]' } }, approvals)?.actual)
    .toBe('matches the original recording');
});

test('handles quoted keys and array elements without matching inherited properties', () => {
  const approvals = parseKnownDifferences([{ ...example, path: '$["odd key"][0].constructor', result: null }]);
  expect(compareWithKnown({ 'odd key': [{}] }, { 'odd key': [{ constructor: null }] }, approvals)).toBeNull();
  expect(() => parseKnownDifferences([{ ...example, path: '$.invalid[01]' }])).toThrow('Invalid JSON path');
  expect(() => parseKnownDifferences([example, example])).toThrow('Duplicate known difference');
  expect(() => parseKnownDifferences([{ ...example, suite: 'conflicts.test.ts' }])).toThrow('exactly one scenario or suite');
});

test('flags an approval below a wildcard even when a sibling still differs', () => {
  const golden = { body: '[..]', status: 200 };
  const actual = { body: { status: 'rust-[..]' }, status: 204 };
  const approvals = parseKnownDifferences([example]);
  expect(compareWithKnown(golden, actual, approvals)).toMatchObject({
    path: '$.body.status', actual: 'matches the original recording',
  });
});

test('edge replay uses approvals only when the build comparison supplies them', () => {
  const golden = { scenario: 'fixture', cases: [{ name: 'sample', expected: { body: { status: 'original' } }, noise: [] }] };
  const known = parseKnownDifferences([example]);
  const original = [{ name: 'sample', capture: golden.cases[0]!.expected, fallbacks: [] }];
  const rust = [{ name: 'sample', capture: { body: { status: 'rust-[..]' } }, fallbacks: [] }];
  expect(compareScenario(golden, original, 'fixture').cases[0]?.difference).toBeNull();
  expect(compareScenario(golden, original, 'fixture', known).cases[0]?.difference?.actual).toBe('matches the original recording');
  expect(compareScenario(golden, rust, 'fixture').cases[0]?.difference?.path).toBe('$.body.status');
  expect(compareScenario(golden, rust, 'fixture', known).cases[0]?.difference).toBeNull();
  expect(compareScenario({ scenario: 'fixture', cases: [] }, [], 'fixture', known).cases[0]?.difference?.actual)
    .toBe('(case no longer recorded)');
});

const listenerDifference = {
  scenario: 'runtime', case: 'request-target-over-listener-limit', path: '$.headers["content-length"]',
  result: '0', reason: 'synthetic approval for the native listener',
};

test('retains build labels only on scenario approvals and rejects ambiguous lists', () => {
  expect(parseKnownDifferences([{ ...listenerDifference, buildLabels: ['native', 'native-debug'] }])[0]).toMatchObject({
    buildLabels: ['native', 'native-debug'],
  });
  for (const buildLabels of [[], [''], ['native', 'native'], ['native', null], 'native', null]) {
    expect(() => parseKnownDifferences([{ ...listenerDifference, buildLabels }])).toThrow('buildLabels');
  }
  const { scenario: _scenario, ...entry } = listenerDifference;
  expect(() => parseKnownDifferences([{ ...entry, suite: 'fixture.test.ts', buildLabels: ['native'] }])).toThrow('buildLabels');
});

test('scopes exact results and stale approvals to matching build labels', () => {
  const { scenario, case: name, path } = listenerDifference;
  const golden = { scenario, cases: [{ name, expected: { status: 431, headers: { connection: 'close' } }, noise: [] }] };
  const known = parseKnownDifferences([{ ...listenerDifference, buildLabels: ['native', 'native-debug'] }]);
  const check = (label: string, length?: string) => {
    const headers = { connection: 'close', ...(length === undefined ? {} : { 'content-length': length }) };
    const actual = [{ name, capture: { status: 431, headers }, fallbacks: [] }];
    return compareScenario(golden, actual, scenario, scenarioKnownDifferencesForBuild(known, label)).cases[0]?.difference;
  };
  expect(check('native', '0')).toBeNull();
  expect(check('native-debug', '0')).toBeNull();
  expect(check('native', '1')).toMatchObject({ path, expected: '"0"', actual: '"1"' });
  expect(check('native')).toMatchObject({ path, actual: 'matches the original recording' });
  expect(check('front-door')).toBeNull();
  expect(check('front-door', '0')).toMatchObject({ path, kind: 'extra' });

  const unscoped = parseKnownDifferences([listenerDifference]);
  expect(scenarioKnownDifferencesForBuild(unscoped, 'native')).toEqual(unscoped);
  expect(scenarioKnownDifferencesForBuild(unscoped, 'front-door')).toEqual(unscoped);
});

test('the trace comparer uses only the approvals for the requested suite and test', () => {
  const suite = 'integration-tests/tests/server/fixture.test.ts';
  const format = (body: string): Traces => new Map([[suite, { sample: { http: [{ body }] } }]]);
  const golden = format('original');
  const rust = format('rust');
  const { scenario: _scenario, ...entry } = example;
  const known = parseKnownDifferences([{ ...entry, suite, path: '$.http[0].body', result: 'rust' }]);
  expect(compareTraces(golden, rust, known)).toEqual({ total: 1, problems: [], excludedBroadcasts: 0, excludedTests: 0, excludedPaths: 0 });
  expect(compareTraces(golden, format('unapproved'), known).problems[0]?.difference.path).toBe('$.http[0].body');
  expect(compareTraces(golden, golden, known).problems[0]?.difference.actual).toBe('matches the original recording');
  expect(compareTraces(golden, rust, parseKnownDifferences([{ ...entry, suite: 'other.test.ts' }])).problems).toHaveLength(1);
});
