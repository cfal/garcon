import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mergeRecordings, wildcardPaths, type Json } from '../wildcard.js';

export const CASES_FILE = 'cases.jsonl';
export const MANIFEST_FILE = 'manifest.json';
// One case is one line. A larger argument or result is listed, not recorded.
export const MAX_CASE_BYTES = 1024 * 1024;

export interface NotCaptured {
  fn: string;
  // Whether the arguments or the outcome could not be encoded.
  where: 'args' | 'result';
  // JSON path of the first value that could not be encoded.
  path: string;
  type: string;
  // `file:line:column` of the test that made the call, when known.
  at: string | null;
  count: number;
}

// What the preload writes for one call: either the encoded call, or why it
// could not be encoded.
export type CaptureRecord =
  | { seq: number; fn: string; args: Json[]; result: Json }
  | { seq: number; fn: string; notCaptured: Omit<NotCaptured, 'fn' | 'count'> };

export interface Case {
  fn: string;
  args: Json[];
  result: Json;
  // `test`, `trap:<name>@<path>`, or `<inputs file>:<line>`.
  origin: string;
}

export interface RecordedCase extends Case {
  id: string;
}

export interface Manifest {
  // Repository-relative path of the recorded module.
  module: string;
  tests: string[];
  inputs: string | null;
  cases: number;
  sha256: string;
  notCaptured: NotCaptured[];
}

export interface Merge {
  cases: Case[];
  notCaptured: NotCaptured[];
  // Every wildcard and every other run-to-run difference, for review.
  noise: string[];
}

// The value of the first run, or the two merged where they differ.
export function sameJson(first: Json | undefined, second: Json | undefined): Json {
  return JSON.stringify(first) === JSON.stringify(second) && first !== undefined
    ? first
    : mergeRecordings(first, second);
}

export function callKey(fn: string, args: Json[]): string {
  return `${fn}\u0000${JSON.stringify(args)}`;
}

function preview(args: Json[]): string {
  const text = JSON.stringify(args);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// One call with the recorded results of every time the tests made it.
type Call = { fn: string; args: Json[]; results: Json[] };

function group(records: CaptureRecord[]): { calls: Map<string, Call>; notCaptured: Map<string, NotCaptured> } {
  const calls = new Map<string, Call>();
  const notCaptured = new Map<string, NotCaptured>();
  for (const record of [...records].sort((left, right) => left.seq - right.seq)) {
    if ('notCaptured' in record) {
      const { where, path, type, at } = record.notCaptured;
      const key = JSON.stringify([record.fn, where, path, type, at]);
      const entry = notCaptured.get(key) ?? { ...record.notCaptured, fn: record.fn, count: 0 };
      entry.count += 1;
      notCaptured.set(key, entry);
      continue;
    }
    const tooLarge = [['args', JSON.stringify(record.args)], ['result', JSON.stringify(record.result)]]
      .find(([, text]) => text.length > MAX_CASE_BYTES);
    const key = callKey(record.fn, record.args);
    if (tooLarge) {
      const entry = notCaptured.get(key) ?? {
        fn: record.fn,
        where: tooLarge[0] as 'args' | 'result',
        path: tooLarge[0] === 'args' ? '$.args' : '$.result',
        type: `more than ${MAX_CASE_BYTES} bytes encoded`,
        at: null,
        count: 0,
      };
      entry.count += 1;
      notCaptured.set(key, entry);
      continue;
    }
    const entry = calls.get(key) ?? { fn: record.fn, args: record.args, results: [] };
    entry.results.push(record.result);
    calls.set(key, entry);
  }
  return { calls, notCaptured };
}

// Merges the two recording runs of the tests. Calls with the same arguments
// are one case per distinct result; a result that differs between the runs
// becomes a wildcard.
export function mergeCaptured(first: CaptureRecord[], second: CaptureRecord[]): Merge {
  const left = group(first);
  const right = group(second);
  const cases: Case[] = [];
  const noise: string[] = [];
  for (const key of new Set([...left.calls.keys(), ...right.calls.keys()])) {
    const here = left.calls.get(key);
    const there = right.calls.get(key);
    const { fn, args } = (here ?? there)!;
    for (const [run, side] of [['first', here], ['second', there]] as const) {
      if (side && new Set(side.results.map((result) => JSON.stringify(result))).size > 1) {
        noise.push(`${fn}(${preview(args)}): different results for the same arguments within the ${run} run`);
      }
    }
    if (!here || !there) {
      noise.push(`${fn}(${preview(args)}): captured in the ${here ? 'first' : 'second'} run only; its result is a wildcard`);
    }
    const seen = new Set<string>();
    const length = Math.max(here?.results.length ?? 0, there?.results.length ?? 0);
    for (let index = 0; index < length; index += 1) {
      // Equal results are kept as recorded, in the original's key order.
      const result = sameJson(here?.results[index], there?.results[index]);
      const text = JSON.stringify(result);
      if (seen.has(text)) continue;
      seen.add(text);
      const wildcards = here && there ? wildcardPaths({ result }, '$') : [];
      if (wildcards.length > 0) noise.push(`${fn}(${preview(args)}): differs between runs at ${wildcards.join(', ')}`);
      cases.push({ fn, args, result, origin: 'test' });
    }
  }
  const notCaptured: NotCaptured[] = [];
  for (const key of new Set([...left.notCaptured.keys(), ...right.notCaptured.keys()])) {
    const here = left.notCaptured.get(key);
    const there = right.notCaptured.get(key);
    notCaptured.push({ ...(here ?? there)!, count: Math.max(here?.count ?? 0, there?.count ?? 0) });
  }
  return { cases, notCaptured, noise };
}

export async function writeCases(outDirectory: string, cases: RecordedCase[], manifest: Omit<Manifest, 'cases' | 'sha256'>): Promise<Manifest> {
  const text = cases.map((entry) => `${JSON.stringify({ id: entry.id, fn: entry.fn, args: entry.args, result: entry.result, origin: entry.origin })}\n`).join('');
  const sha256 = createHash('sha256').update(text).digest('hex');
  const written: Manifest = { ...manifest, cases: cases.length, sha256 };
  await mkdir(outDirectory, { recursive: true });
  await writeFile(join(outDirectory, CASES_FILE), text);
  await writeFile(join(outDirectory, MANIFEST_FILE), `${JSON.stringify(written, null, 2)}\n`);
  return written;
}

// Reads a recording and fails when the case file is not the one the manifest
// was written for.
export async function readCases(outDirectory: string): Promise<{ manifest: Manifest; cases: RecordedCase[] }> {
  let text: string;
  try {
    text = await readFile(join(outDirectory, CASES_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${outDirectory}/${CASES_FILE} not found; run \`bun rust/parity/cli.ts unit record\`.`);
    }
    throw error;
  }
  const manifest = JSON.parse(await readFile(join(outDirectory, MANIFEST_FILE), 'utf8')) as Manifest;
  const sha256 = createHash('sha256').update(text).digest('hex');
  if (sha256 !== manifest.sha256) {
    throw new Error(`${outDirectory}/${CASES_FILE} is not the recorded file (sha256 ${sha256.slice(0, 12)}, manifest ${String(manifest.sha256).slice(0, 12)}). A case file is never edited by hand; record again.`);
  }
  const cases = text.split('\n').filter(Boolean).map((line): RecordedCase => {
    const entry = JSON.parse(line) as Partial<RecordedCase>;
    if (typeof entry.id !== 'string' || typeof entry.fn !== 'string' || !Array.isArray(entry.args) || entry.result === undefined) {
      throw new Error(`${outDirectory}/${CASES_FILE}: a malformed case: ${line.slice(0, 120)}`);
    }
    return entry as RecordedCase;
  });
  if (cases.length !== manifest.cases) {
    throw new Error(`${outDirectory}/${CASES_FILE}: ${cases.length} cases, manifest ${manifest.cases}`);
  }
  return { manifest, cases };
}
