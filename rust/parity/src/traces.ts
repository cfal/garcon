import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { compareWithKnown, missingKnownCase, type KnownDifference } from './known-differences.js';
import { traceGroup, type TraceExclusion } from './trace-unstable.js';
import { childPath, firstDifference, isObject, mergeRecordings, wildcardPaths, type Difference, type Json } from './wildcard.js';
import type { TraceRecord } from './trace-sink.js';

type Tests = Record<string, Json>;
export type Traces = Map<string, Tests>;
type Streams = { http: Json[]; replies: Json[]; broadcasts: Record<string, Json[]> };

export function groupTrace(records: TraceRecord[]): Tests {
  const tests = new Map<string, Streams>();
  for (const { test, stream, group, value } of records.sort((a, b) => a.order - b.order)) {
    const streams = tests.get(test) ?? { http: [], replies: [], broadcasts: {} };
    if (stream === 'broadcasts') {
      if (group === undefined) throw new Error(`A broadcast for ${test} has no chat/type group`);
      (streams.broadcasts[group] ??= []).push(value);
    } else {
      streams[stream].push(value);
    }
    tests.set(test, streams);
  }
  return Object.fromEntries(tests);
}

export async function readTraces(directory: string, ext: 'json' | 'jsonl'): Promise<Traces> {
  const traces: Traces = new Map();
  const files = (await Array.fromAsync(new Bun.Glob(`**/*.test.*.${ext}`).scan(directory))).sort();
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8');
    const tests = ext === 'json' ? JSON.parse(text) as Tests : groupTrace(text.trimEnd().split('\n').map((line) => JSON.parse(line) as TraceRecord));
    traces.set(file.slice(0, -ext.length - 1), tests);
  }
  return traces;
}

function stableJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Structural and ordering differences are evidence, not wildcard candidates.
function unstable(left: Json | undefined, right: Json | undefined, path = '$'): Difference | null {
  if (left === undefined || right === undefined) return firstDifference(left, right, path);
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return firstDifference(left, right, path + '.length');
    const before = left.map(stableJson);
    const after = right.map(stableJson);
    const moved = before.findIndex((key, index) => key !== after[index]);
    const asSet = (values: string[]) => JSON.stringify([...values].sort());
    if (moved !== -1 && asSet(before) === asSet(after)) {
      return { path: childPath(path, moved), kind: 'order', expected: before[moved], actual: after[moved] };
    }
    for (let i = 0; i < left.length; i++) {
      const difference = unstable(left[i], right[i], childPath(path, i));
      if (difference) return difference;
    }
    return null;
  }
  if (isObject(left) && isObject(right)) {
    for (const key of keys(left, right)) {
      const a = Object.hasOwn(left, key) ? left[key] : undefined;
      const b = Object.hasOwn(right, key) ? right[key] : undefined;
      const field = childPath(path, key);
      const discriminant = key === 'type' || key === 'status' || key === 'method' || path.endsWith('.request') && key === 'path';
      const difference = discriminant && !isObject(a) && !isObject(b) ? firstDifference(a, b, field) : unstable(a, b, field);
      if (difference) return difference;
    }
    return null;
  }
  if (Array.isArray(left) || Array.isArray(right) || isObject(left) || isObject(right)
    || typeof left !== typeof right || left === null || right === null || typeof left === 'boolean') {
    return firstDifference(left, right, path);
  }
  return null;
}

const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
const suites = (...runs: Traces[]) => [...new Set(runs.flatMap((run) => [...run.keys()]))].sort();

export interface TraceDifference {
  suite: string;
  test: string;
  difference: Difference;
}

function differing(samples: (Json | undefined)[], path = '$'): Difference | null {
  for (let i = 1; i < samples.length; i++) {
    for (let j = 0; j < i; j++) {
      const difference = unstable(samples[j], samples[i], path);
      if (difference) return difference;
    }
  }
  return null;
}

function withoutGroups(sample: Json | undefined, groups: ReadonlySet<string>): Json | undefined {
  if (!isObject(sample) || !isObject(sample.broadcasts) || !groups.size) return sample;
  return { ...sample, broadcasts: Object.fromEntries(Object.entries(sample.broadcasts).filter(([key]) => !groups.has(key))) };
}

function suiteExclusions(exclusions: readonly TraceExclusion[], suite: string) {
  const tests = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const entry of exclusions) {
    if (entry.suite !== suite) continue;
    if ('test' in entry) tests.set(entry.test, entry.reason);
    else groups.set(traceGroup(entry.chat, entry.type), entry.reason);
  }
  return { tests, groups };
}

function stableStreams(
  samples: (Json | undefined)[],
  declaredGroups: ReadonlyMap<string, string>,
  report: (difference: Difference) => void,
): { values: (Json | undefined)[]; excluded: Json[] } {
  const broadcasts = samples.map((value) => isObject(value) && isObject(value.broadcasts) ? value.broadcasts : {});
  const omitted = new Set(declaredGroups.keys());
  const excluded: Json[] = [];
  for (const group of [...new Set(broadcasts.flatMap((value) => Object.keys(value)))].sort()) {
    if (omitted.has(group)) continue;
    const path = childPath('$.broadcasts', group);
    const difference = differing(broadcasts.map((value) => Object.hasOwn(value, group) ? value[group] : undefined), path);
    if (!difference) continue;
    report(difference);
    excluded.push({ group, path: difference.path, kind: difference.kind });
    omitted.add(group);
  }
  return { values: samples.map((value) => withoutGroups(value, omitted)), excluded };
}

function mergeSamples(samples: Json[]): Json {
  const [first, ...rest] = samples;
  if (Array.isArray(first)) return first.map((_, i) => mergeSamples(samples.map((value) => (value as Json[])[i])));
  if (isObject(first)) return Object.fromEntries(Object.keys(first).sort().map((key) => [
    key, mergeSamples(samples.map((value) => (value as typeof first)[key])),
  ]));
  const merged = rest.reduce((pattern, value) => firstDifference(pattern, value) ? mergeRecordings(pattern, value) : pattern, first!);
  return samples.every((sample) => !firstDifference(merged, sample)) ? merged : '[..]';
}

export function mergeTraces(runs: [Traces, Traces, ...Traces[]], exclusions: readonly TraceExclusion[] = []): {
  golden: Traces;
  problems: TraceDifference[];
  noise: string[];
  unstableBroadcasts: TraceDifference[];
} {
  const golden: Traces = new Map();
  const problems: TraceDifference[] = [];
  const noise: string[] = [];
  const unstableBroadcasts: TraceDifference[] = [];
  for (const suite of suites(...runs)) {
    const declarations = suiteExclusions(exclusions, suite);
    const sampleTests = runs.map((run) => run.get(suite) ?? {});
    const tests = new Map<string, Json>();
    for (const test of [...new Set(sampleTests.flatMap((sample) => Object.keys(sample)))].sort()) {
      if (declarations.tests.has(test)) continue;
      const samples = sampleTests.map((sample) => Object.hasOwn(sample, test) ? sample[test] : undefined);
      const streams = stableStreams(samples, declarations.groups, (difference) => unstableBroadcasts.push({ suite, test, difference }));
      const difference = differing(streams.values);
      if (difference) {
        problems.push({ suite, test, difference });
        continue;
      }
      const merged = mergeSamples(streams.values as Json[]);
      const value = streams.excluded.length && isObject(merged)
        ? { ...merged, unstableBroadcasts: streams.excluded }
        : merged;
      tests.set(test, value);
      for (const path of wildcardPaths(value)) noise.push(`${suite} > ${test} at ${path}`);
    }
    golden.set(suite, Object.fromEntries(tests));
  }
  return { golden, problems, noise, unstableBroadcasts };
}

export async function writeTraces(directory: string, traces: Traces): Promise<void> {
  for (const [suite, tests] of traces) {
    const file = join(directory, `${suite}.json`);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(tests, null, 2)}\n`, { mode: 0o600 });
  }
}

export function compareTraces(expected: Traces, actual: Traces, known: readonly KnownDifference[] = [], exclusions: readonly TraceExclusion[] = []): {
  total: number;
  problems: TraceDifference[];
  excludedBroadcasts: number;
  excludedTests: number;
} {
  const problems: TraceDifference[] = [];
  let total = 0;
  let excludedBroadcasts = 0;
  let excludedTests = 0;
  for (const suite of suites(expected, actual)) {
    const before = expected.get(suite) ?? {};
    const after = actual.get(suite) ?? {};
    const approvals = known.filter((entry) => entry.scope === 'suite' && entry.name === suite);
    const declarations = suiteExclusions(exclusions, suite);
    excludedTests += declarations.tests.size;
    excludedBroadcasts += declarations.groups.size;
    const names = new Set(keys(before, after));
    for (const test of names) {
      if (declarations.tests.has(test)) continue;
      total += 1;
      let expectedTest = Object.hasOwn(before, test) ? before[test] : undefined;
      const groups = new Set(declarations.groups.keys());
      if (isObject(expectedTest) && Array.isArray(expectedTest.unstableBroadcasts)) {
        const { unstableBroadcasts, ...streams } = expectedTest;
        expectedTest = streams;
        for (const entry of unstableBroadcasts) {
          if (!isObject(entry) || typeof entry.group !== 'string' || groups.has(entry.group)) continue;
          excludedBroadcasts += 1;
          groups.add(entry.group);
        }
      }
      const actualTest = Object.hasOwn(after, test) ? after[test] : undefined;
      const difference = compareWithKnown(withoutGroups(expectedTest, groups), withoutGroups(actualTest, groups), approvals.filter((entry) => entry.case === test));
      if (difference) problems.push({ suite, test, difference });
    }
    for (const entry of approvals) {
      if (names.has(entry.case) || declarations.tests.has(entry.case)) continue;
      names.add(entry.case);
      total += 1;
      problems.push({ suite, test: entry.case, difference: missingKnownCase(entry) });
    }
  }
  return { total, problems, excludedBroadcasts, excludedTests };
}

export function formatTraceDifferences(problems: TraceDifference[], label = 'FAIL'): string {
  const lines: string[] = [];
  const groups = new Map<string, number>();
  for (const { suite, test, difference: { path, kind, expected, actual } } of problems) {
    lines.push(`${label} ${suite} > ${test} at ${path}: expected ${expected}, got ${actual}`);
    const key = `${path.replace(/\[\d+\]/g, '[]')} | ${kind}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  if (groups.size) {
    lines.push('', '| Path | Kind | Count |', '| --- | --- | ---: |');
    for (const [key, count] of [...groups].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${key} | ${count} |`);
  }
  return lines.join('\n');
}
