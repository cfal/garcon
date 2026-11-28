#!/usr/bin/env bun
// Compares end-to-end suite outcomes between two controllers, test by test.
// Each argument is a JUnit report file or a directory of them, as written by
// `bun test --reporter=junit`. Exits non-zero when any test's outcome differs
// or a test ran under only one controller. See rust/README.md.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type Outcome = 'pass' | 'fail' | 'skip';
type JunitReport = Map<string, Outcome[]>;

interface PositionalPairing {
  test: string;
  paired: number;
  original: number;
  candidate: number;
}

const decodeEntities = (text: string) => text
  .replaceAll('&quot;', '"').replaceAll('&apos;', '\'').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function attribute(tag: string, name: string): string {
  return decodeEntities(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '');
}

function testLabel(key: string): string {
  return (JSON.parse(key) as string[]).filter(Boolean).join(' > ');
}

// Groups by file, describe path, and name, retaining XML order within a group.
export function parseJunit(xml: string): JunitReport {
  const outcomes: JunitReport = new Map();
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const tag = match[1];
    const body = match[3] ?? '';
    const key = JSON.stringify(['file', 'classname', 'name'].map((name) => attribute(tag, name)));
    const outcome: Outcome = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    const group = outcomes.get(key);
    if (group) group.push(outcome);
    else outcomes.set(key, [outcome]);
  }
  return outcomes;
}

export async function readReports(path: string): Promise<JunitReport> {
  const files = (await stat(path)).isDirectory()
    ? (await readdir(path)).filter((name) => name.endsWith('.xml')).sort().map((name) => join(path, name))
    : [path];
  if (files.length === 0) throw new Error('No JUnit test cases found');
  const outcomes: JunitReport = new Map();
  for (const file of files) {
    const report = parseJunit(await readFile(file, 'utf8'));
    if (report.size === 0) throw new Error('No JUnit test cases found');
    for (const [key, group] of report) {
      if (outcomes.has(key)) throw new Error(`Duplicate JUnit test across reports: ${testLabel(key)}`);
      outcomes.set(key, group);
    }
  }
  return outcomes;
}

export function compareOutcomes(original: ReadonlyMap<string, readonly Outcome[]>, candidate: ReadonlyMap<string, readonly Outcome[]>) {
  const keys = [...new Set([...original.keys(), ...candidate.keys()])].sort();
  let failedBoth = 0;
  let total = 0;
  const differences = [];
  const positionalPairings: PositionalPairing[] = [];
  for (const key of keys) {
    const left = original.get(key) ?? [];
    const right = candidate.get(key) ?? [];
    const count = Math.max(left.length, right.length);
    const repeated = count > 1;
    const test = testLabel(key);
    total += count;
    if (repeated) positionalPairings.push({ test, paired: Math.min(left.length, right.length), original: left.length, candidate: right.length });
    for (let index = 0; index < count; index++) {
      const expected = left[index];
      const actual = right[index];
      if (expected !== actual) differences.push({
        test: repeated ? `${test} (occurrence ${index + 1})` : test,
        expected: expected ?? 'absent', actual: actual ?? 'absent',
      });
      else if (expected === 'fail') failedBoth += 1;
    }
  }
  return { same: total - differences.length, failedBoth, differences, positionalPairings };
}

export function describePositionalPairing(pairing: PositionalPairing): string {
  return `${pairing.test}: paired ${pairing.paired} by position (original=${pairing.original}, candidate=${pairing.candidate})`;
}

function tally(outcomes: JunitReport): string {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const group of outcomes.values()) for (const outcome of group) counts[outcome] += 1;
  return `${counts.pass + counts.fail + counts.skip} tests: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`;
}

if (import.meta.main) {
  const [leftPath, rightPath] = Bun.argv.slice(2);
  if (!leftPath || !rightPath) {
    console.log('Usage: bun rust/parity/compare-junit.ts <original report or dir> <front-door report or dir>');
    process.exit(2);
  }
  const left = await readReports(leftPath);
  const right = await readReports(rightPath);
  console.log(`original:   ${tally(left)}`);
  console.log(`front door: ${tally(right)}`);
  const { same, differences, positionalPairings } = compareOutcomes(left, right);
  for (const pairing of positionalPairings) console.log(describePositionalPairing(pairing));
  for (const { test, expected, actual } of differences) {
    console.log(`DIFFERS ${test}: original=${expected} front-door=${actual}`);
  }
  console.log(differences.length === 0 ? `Identical outcomes for all ${same} tests.` : `${differences.length} of ${same + differences.length} tests differ.`);
  process.exit(differences.length === 0 ? 0 : 1);
}
