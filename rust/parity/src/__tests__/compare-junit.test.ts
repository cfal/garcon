import { expect, test } from 'bun:test';
import { parseJunit } from '../../compare-junit.js';

test('keys test cases by file and name and classifies their outcome', () => {
  const xml = `<testsuites><testsuite name="a.test.ts">
    <testcase name="passes &amp; settles" classname="suite" file="tests/a.test.ts" time="0.1" />
    <testcase name="fails" classname="suite" file="tests/a.test.ts"><failure type="AssertionError" /></testcase>
    <testcase name="is skipped" classname="suite" file="tests/a.test.ts"><skipped /></testcase>
  </testsuite></testsuites>`;
  expect([...parseJunit(xml)]).toEqual([
    ['tests/a.test.ts > passes & settles', 'pass'],
    ['tests/a.test.ts > fails', 'fail'],
    ['tests/a.test.ts > is skipped', 'skip'],
  ]);
});
