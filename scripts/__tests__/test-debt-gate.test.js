import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { testDebtProblems } from '../test-debt-gate.ts';

const existing = 'server/controller/agents/__tests__/old.test.ts';
test('test debt shrinks by file identity, never by diagnostic count', () => {
  expect(testDebtProblems([existing], [], [])).toEqual([]);
  expect(testDebtProblems([existing], [existing], [])).toEqual([]);
  expect(testDebtProblems([], [existing], [])).toEqual([`Test exclusion grew: ${existing}`]);
  expect(testDebtProblems(null, ['server/**/__tests__/*.ts'], [])).not.toEqual([]);
  expect(testDebtProblems(null, [existing, existing], [])).toContain('Duplicate test exclusions');
});

test('new backend tests use TS while existing JS tests can remain', () => {
  for (const owner of ['server', 'server-agents/amp', 'cli']) {
    expect(testDebtProblems([], [], [`${owner}/__tests__/new.test.js`])).toHaveLength(1);
    expect(testDebtProblems([], [], [`${owner}/__tests__/new.test.ts`])).toEqual([]);
  }
});

test('every current test exclusion names a real file', () => {
  const config = JSON.parse(readFileSync(new URL('../../tsconfig.tests.json', import.meta.url), 'utf8'));
  expect(testDebtProblems(null, config.exclude, [])).toEqual([]);
  for (const file of config.exclude) expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
});
