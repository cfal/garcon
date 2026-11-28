import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareOutcomes, parseJunit, readReports } from '../../compare-junit.js';

test('distinguishes same-name cases within a file and classifies their outcomes', () => {
  const xml = `<testsuites><testsuite name="a.test.ts">
    <testcase name="passes &amp; settles" classname="suite" file="tests/a.test.ts" time="0.1" />
    <testcase name="passes &amp; settles" classname="other &amp; suite" file="tests/a.test.ts"><failure type="AssertionError" /></testcase>
    <testcase name="is skipped" file="tests/a.test.ts"><skipped /></testcase>
  </testsuite></testsuites>`;
  const original = parseJunit(xml);
  expect([...original.values()].flat()).toEqual(['pass', 'fail', 'skip']);
  const candidate = parseJunit(xml.replace('<failure type="AssertionError" />', ''));
  expect(compareOutcomes(original, candidate)).toEqual({
    same: 2, failedBoth: 0, positionalPairings: [],
    differences: [{ test: 'tests/a.test.ts > other & suite > passes & settles', expected: 'fail', actual: 'pass' }],
  });
});

test('pairs repeated Bun parameterized titles by occurrence without losing failures', () => {
  const entry = (body: string) => `<testcase file="tests/executor-cli.test.ts" classname="executor" name="named=%s">${body}</testcase>`;
  const original = parseJunit(entry('<failure/>') + entry(''));
  const same = compareOutcomes(original, original);
  expect(same).toEqual({
    same: 2, failedBoth: 1, differences: [],
    positionalPairings: [{ test: 'tests/executor-cli.test.ts > executor > named=%s', paired: 2, original: 2, candidate: 2 }],
  });
  const swapped = compareOutcomes(original, parseJunit(entry('') + entry('<failure/>')));
  expect(swapped.differences).toEqual([
    { test: 'tests/executor-cli.test.ts > executor > named=%s (occurrence 1)', expected: 'fail', actual: 'pass' },
    { test: 'tests/executor-cli.test.ts > executor > named=%s (occurrence 2)', expected: 'pass', actual: 'fail' },
  ]);
});

test('rejects duplicate identities across separate reports on the same side', async () => {
  const entry = '<testcase file="tests/a.test.ts" classname="suite" name="joined"/>';
  const xml = `<testsuites><testsuite>${entry}</testsuite></testsuites>`;
  const directory = await mkdtemp(join(tmpdir(), 'parity-junit-'));
  try {
    await writeFile(join(directory, 'first.xml'), xml);
    await writeFile(join(directory, 'second.xml'), xml);
    await expect(readReports(directory)).rejects.toThrow('Duplicate JUnit test across reports: tests/a.test.ts > suite > joined');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
