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
  expect([...original.values()]).toEqual(['pass', 'fail', 'skip']);
  const candidate = parseJunit(xml.replace('<failure type="AssertionError" />', ''));
  expect(compareOutcomes(original, candidate)).toEqual({
    same: 2, failedBoth: 0,
    differences: [{ test: 'tests/a.test.ts > other & suite > passes & settles', expected: 'fail', actual: 'pass' }],
  });
});

test('rejects duplicate identities within one report and across reports', async () => {
  const entry = '<testcase file="tests/a.test.ts" classname="suite" name="joined"/>';
  const xml = `<testsuites><testsuite>${entry}</testsuite></testsuites>`;
  expect(() => parseJunit(entry.repeat(2))).toThrow('Duplicate JUnit test: tests/a.test.ts > suite > joined');
  const directory = await mkdtemp(join(tmpdir(), 'parity-junit-'));
  try {
    await writeFile(join(directory, 'first.xml'), xml);
    await writeFile(join(directory, 'second.xml'), xml);
    await expect(readReports(directory)).rejects.toThrow('Duplicate JUnit test: tests/a.test.ts > suite > joined');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
