#!/usr/bin/env bun
// Compares end-to-end suite outcomes between two controllers, test by test.
// Each argument is a JUnit report file or a directory of them, as written by
// `bun test --reporter=junit`. Exits non-zero when any test's outcome differs
// or a test ran under only one controller. See rust/README.md.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

type Outcome = 'pass' | 'fail' | 'skip';

const decodeEntities = (text: string) => text
  .replaceAll('&quot;', '"').replaceAll('&apos;', '\'').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

function attribute(tag: string, name: string): string {
  return decodeEntities(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '');
}

// Keys each test by its file, describe path, and name.
export function parseJunit(xml: string): Map<string, Outcome> {
  const outcomes = new Map<string, Outcome>();
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const tag = match[1];
    const body = match[3] ?? '';
    const key = `${attribute(tag, 'file') || attribute(tag, 'classname')} > ${attribute(tag, 'name')}`;
    const outcome: Outcome = /<(failure|error)\b/.test(body) ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass';
    outcomes.set(key, outcome);
  }
  return outcomes;
}

async function readReports(path: string): Promise<Map<string, Outcome>> {
  const files = (await stat(path)).isDirectory()
    ? (await readdir(path)).filter((name) => name.endsWith('.xml')).sort().map((name) => join(path, name))
    : [path];
  const outcomes = new Map<string, Outcome>();
  for (const file of files) {
    for (const [key, outcome] of parseJunit(await readFile(file, 'utf8'))) outcomes.set(key, outcome);
  }
  return outcomes;
}

function tally(outcomes: Map<string, Outcome>): string {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const outcome of outcomes.values()) counts[outcome] += 1;
  return `${outcomes.size} tests: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`;
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
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differing = keys.filter((key) => left.get(key) !== right.get(key));
  for (const key of differing) {
    console.log(`DIFFERS ${key}: original=${left.get(key) ?? 'absent'} front-door=${right.get(key) ?? 'absent'}`);
  }
  console.log(differing.length === 0 ? `Identical outcomes for all ${keys.length} tests.` : `${differing.length} of ${keys.length} tests differ.`);
  process.exit(differing.length === 0 ? 0 : 1);
}
