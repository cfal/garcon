import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { isObject, wildcardPaths, type Json } from '../wildcard.js';
import { callKey, mergeCaptured, sameJson, type CaptureRecord, type Case, type Guard, type GuardSpec, type Manifest, type NotCaptured, type RecordedCase } from './cases.js';
import type { EncodeFailure } from './encode.js';
import { runWithRecordStream, type StreamRun } from './process.js';
import { trapVariants } from './traps.js';

const PRELOAD = resolve(import.meta.dir, 'record-preload.ts');
const EVALUATOR = resolve(import.meta.dir, 'evaluate.ts');
const EVALUATE_STREAM_VARIABLE = 'GARCON_UNIT_EVALUATE_FD';
// The variables of record-preload.ts, which cannot be imported here without
// running the preload.
const MODULE_VARIABLE = 'GARCON_UNIT_RECORD_MODULE';
const RECORD_STREAM_VARIABLE = 'GARCON_UNIT_RECORD_FD';
const ROOT_VARIABLE = 'GARCON_UNIT_RECORD_ROOT';
// A call that has no outcome after this long is given up and listed.
export const EVALUATE_STALL_MS = 15_000;

// A call the evaluator makes. The guard of a trap variant, as the evaluator
// loads it, holds the call back when it rejects the argument.
export interface EvaluationInput {
  fn: string;
  args: Json[];
  guard?: { argument: number; spec: string };
}

// A call to make in a fresh process: a trap variant of a recorded call, or a
// line of the inputs file.
export interface Input extends EvaluationInput {
  kind: 'trap' | 'input';
  // `trap:<name>@<path>`, or `<inputs file>:<line>`.
  origin: string;
}

// What one evaluation run observed for one input.
export type Evaluation =
  | { result: Json }
  | { notCaptured: EncodeFailure }
  | { missing: true }
  | { timedOut: true }
  // The guard of the trap variant rejected its argument.
  | { guarded: true };

// A fixed time zone and locale keep recordings comparable across machines.
function childEnvironment(variables: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, TZ: 'UTC', LANG: 'C.UTF-8' };
  delete environment.LC_ALL;
  return { ...environment, ...variables };
}

function childFailure(title: string, run: StreamRun): Error {
  return new Error(`${title}\n\n${run.output.trimEnd()}`);
}

// Runs each test file in its own process, as the repository runs them, and
// returns every call the tests made to the module's function exports.
export async function captureTests(repoRoot: string, modulePath: string, tests: string[]): Promise<CaptureRecord[]> {
  const records: CaptureRecord[] = [];
  for (const test of tests) {
    const file = resolve(repoRoot, test);
    const batch: CaptureRecord[] = [];
    const run = await runWithRecordStream([process.execPath, 'test', '--preload', PRELOAD, file], childEnvironment({
      [MODULE_VARIABLE]: modulePath,
      [RECORD_STREAM_VARIABLE]: '3',
      [ROOT_VARIABLE]: repoRoot,
    }), {
      onRecord: (record) => {
        if (!isObject(record) || typeof record.seq !== 'number' || typeof record.fn !== 'string'
          || !('notCaptured' in record) && !Array.isArray(record.args)) {
          throw new Error('malformed record');
        }
        batch.push(record as unknown as CaptureRecord);
      },
    });
    if (run.malformed) throw new Error(`The recorder wrote a malformed record: ${run.malformed}`);
    if (run.code !== 0) {
      throw childFailure(`bun test ${relative(repoRoot, file)} exited with code ${run.code}. Record passing tests: a failing test's calls are not evidence. If the file passes without the recorder, the interception changed its behavior; give the calls in an inputs file instead (--inputs).`, run);
    }
    records.push(...batch.sort((left, right) => left.seq - right.seq));
  }
  return records;
}

// Calls the module's exports with the inputs, in order, in a fresh process,
// and returns each outcome. A call that stalls ends its process; the run then
// resumes with the next input.
export async function evaluateInputs(modulePath: string, inputs: ReadonlyArray<EvaluationInput>, stallMs = EVALUATE_STALL_MS): Promise<Evaluation[]> {
  const evaluations: Evaluation[] = [];
  while (evaluations.length < inputs.length) {
    const remaining = inputs.length - evaluations.length;
    const received: Evaluation[] = [];
    let open = true;
    const run = await runWithRecordStream([process.execPath, EVALUATOR, modulePath], childEnvironment({ [EVALUATE_STREAM_VARIABLE]: '3' }), {
      stdin: inputs.slice(evaluations.length).map((input) => JSON.stringify(input)).join('\n'),
      stallMs,
      onRecord: (record) => {
        if (!open) return;
        if (!isObject(record) || !['result', 'notCaptured', 'missing', 'guarded'].some((key) => key in record)) {
          throw new Error('malformed evaluation');
        }
        received.push(record as unknown as Evaluation);
      },
    });
    open = false;
    if (run.malformed) throw new Error(`The unit evaluator wrote a malformed record: ${run.malformed}`);
    evaluations.push(...received);
    if (!run.stalled) {
      if (received.length !== remaining) {
        throw childFailure(`The unit evaluator stopped after ${received.length} of ${remaining} calls (exit code ${run.code}).`, run);
      }
      break;
    }
    // The calls run in order, so the one that stalled is the first without an outcome.
    if (evaluations.length < inputs.length) evaluations.push({ timedOut: true });
  }
  return evaluations;
}

async function readInputs(repoRoot: string, path: string): Promise<Input[]> {
  const lines = (await readFile(path, 'utf8')).split('\n');
  const inputs: Input[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as Partial<Input>;
    if (typeof entry.fn !== 'string' || !Array.isArray(entry.args)) {
      throw new Error(`${path}:${index + 1}: an input is a JSON line of { "fn": "...", "args": [...] }`);
    }
    inputs.push({ fn: entry.fn, args: entry.args, kind: 'input', origin: `${relative(repoRoot, path)}:${index + 1}` });
  }
  return inputs;
}

interface MergedEvaluation {
  result?: Json;
  notCaptured?: NotCaptured;
  // The guard of the trap variant rejected it in both runs, so it is not a case.
  guarded?: true;
  noise: string[];
}

// Merges the two evaluation runs of one input.
export function mergeEvaluation(input: Input, first: Evaluation, second: Evaluation, stallMs: number): MergedEvaluation {
  const label = `${input.fn} (${JSON.stringify(input.args).slice(0, 80)}) [${input.origin}]`;
  if ('guarded' in first && 'guarded' in second) return { guarded: true, noise: [] };
  if ('timedOut' in first || 'timedOut' in second) {
    return { noise: [], notCaptured: { fn: input.fn, where: 'result', path: '$.result', type: `no outcome within ${stallMs} ms`, at: null, count: 1 } };
  }
  if ('missing' in first || 'missing' in second) {
    throw new Error(`The original does not export a function the inputs call: ${input.fn}.`);
  }
  if ('notCaptured' in first || 'notCaptured' in second) {
    const failure = 'notCaptured' in first ? first.notCaptured : (second as { notCaptured: EncodeFailure }).notCaptured;
    return { noise: [], notCaptured: { fn: input.fn, where: 'result', ...failure, at: null, count: 1 } };
  }
  // A guard that decides differently in two runs of the same input would
  // leave what is recorded to chance.
  if ('guarded' in first || 'guarded' in second) {
    throw new Error(`A guard of ${input.fn} did not decide the same way in both runs: ${label}.`);
  }
  const result = sameJson(first.result, second.result);
  return { result, noise: wildcardPaths({ result }, '$').map((path) => `${label}: differs between runs at ${path}`) };
}

export interface RecordOptions {
  repoRoot: string;
  module: string;
  tests: string[];
  // A JSONL file of `{ "fn", "args" }` lines for calls the tests do not make.
  inputs?: string;
  // Guards of typed arguments: a trap variant of such an argument is recorded
  // only when the original's own guard accepts it.
  guards?: GuardSpec[];
  // How long a call may take before it is given up and listed.
  stallMs?: number;
}

export interface Recording {
  modulePath: string;
  cases: RecordedCase[];
  // The manifest without the case count and the digest, which writing adds.
  manifest: Omit<Manifest, 'cases' | 'sha256'>;
  // The review of the recording: its count, what each guard dropped, every
  // wildcard, every call not captured.
  review: string[];
}

// A guard while recording: what the evaluator loads, what the manifest shows,
// and how many trap variants it dropped and kept.
interface CountedGuard {
  fn: string;
  argument: number;
  spec: string;
  shown: string;
  dropped: number;
  kept: number;
}

const guardKey = (fn: string, argument: number): string => JSON.stringify([fn, argument]);

// A guard of another file than the recorded module is written `<file>#<export>`.
function guardParts(guard: string): { file: string | null; name: string } {
  const hash = guard.indexOf('#');
  return hash === -1 ? { file: null, name: guard } : { file: guard.slice(0, hash), name: guard.slice(hash + 1) };
}

async function countedGuards(repoRoot: string, specs: readonly GuardSpec[]): Promise<Map<string, CountedGuard>> {
  const guards = new Map<string, CountedGuard>();
  for (const { fn, argument, guard } of specs) {
    if (guards.has(guardKey(fn, argument))) throw new Error(`Two guards for argument ${argument} of ${fn}.`);
    const { file, name } = guardParts(guard);
    const path = file === null ? null : resolve(repoRoot, file);
    if (path !== null && !(await stat(path).catch(() => null))?.isFile()) {
      throw new Error(`--guard ${fn}:${argument}=${guard}: not a file: ${file}`);
    }
    const shown = path === null ? name : `${shownPath(repoRoot, path)}#${name}`;
    guards.set(guardKey(fn, argument), { fn, argument, spec: path === null ? name : `${path}#${name}`, shown, dropped: 0, kept: 0 });
  }
  return guards;
}

// A path as a recording shows it: relative to the repository, or absolute
// when it is outside it.
function shownPath(repoRoot: string, path: string): string {
  const shown = relative(repoRoot, path);
  return shown.startsWith('..') ? path : shown;
}

// Records a module in memory: the calls its tests make to its exports, from
// two runs; trap variants of those calls; and the explicit inputs, each
// evaluated in two fresh processes. A result that differs between the two
// runs of a pair becomes a wildcard and is reported in the review.
export async function recordUnit(options: RecordOptions): Promise<Recording> {
  const modulePath = resolve(options.repoRoot, options.module);
  if (!(await stat(modulePath).catch(() => null))?.isFile()) {
    throw new Error(`Not a file: ${options.module}`);
  }
  const guards = await countedGuards(options.repoRoot, options.guards ?? []);
  const observed = mergeCaptured(
    await captureTests(options.repoRoot, modulePath, options.tests),
    await captureTests(options.repoRoot, modulePath, options.tests),
  );
  const inputsPath = options.inputs ? resolve(options.repoRoot, options.inputs) : null;
  const explicit = inputsPath ? await readInputs(options.repoRoot, inputsPath) : [];
  if (observed.cases.length === 0 && explicit.length === 0) {
    throw new Error(`No call to a function export of ${options.module} was captured. The tests must import it and call its exports.`);
  }

  const functions = [...new Set([...observed.cases, ...explicit].map((entry) => entry.fn))];
  const known = new Set(observed.cases.map((entry) => callKey(entry.fn, entry.args)));
  const inputs: Input[] = [];
  const noise = [...observed.noise];
  for (const fn of functions) {
    const variants = trapVariants(
      observed.cases.filter((entry) => entry.fn === fn).map((entry) => entry.args),
      (args) => {
        const key = callKey(fn, args);
        if (known.has(key)) return true;
        known.add(key);
        return false;
      },
    );
    // A call the tests made is always a case; only a trap variant asks its guard.
    inputs.push(...variants.map((variant): Input => {
      const guard = guards.get(guardKey(fn, variant.argument));
      return { fn, args: variant.args, kind: 'trap', origin: variant.origin, ...(guard ? { guard: { argument: variant.argument, spec: guard.spec } } : {}) };
    }));
  }
  for (const input of explicit) {
    if (known.has(callKey(input.fn, input.args))) {
      noise.push(`${input.fn} (${JSON.stringify(input.args).slice(0, 80)}) [${input.origin}]: equals a recorded case; not repeated`);
      continue;
    }
    inputs.push(input);
  }

  const stallMs = options.stallMs ?? EVALUATE_STALL_MS;
  const first = await evaluateInputs(modulePath, inputs, stallMs);
  const second = await evaluateInputs(modulePath, inputs, stallMs);
  const evaluated = inputs.map((input, index) => ({ input, ...mergeEvaluation(input, first[index]!, second[index]!, stallMs) }));
  const notCaptured = [...observed.notCaptured];
  // Inputs that could not be encoded have no call site to name, so they are
  // counted per function and reason.
  const counted = new Map<string, NotCaptured>();
  for (const entry of evaluated) {
    if (entry.input.guard) {
      const guard = guards.get(guardKey(entry.input.fn, entry.input.guard.argument))!;
      if (entry.guarded) guard.dropped += 1;
      else guard.kept += 1;
    }
    noise.push(...entry.noise);
    if (!entry.notCaptured) continue;
    const { at: _at, ...rest } = entry.notCaptured;
    const key = JSON.stringify(rest);
    const known = counted.get(key);
    if (known) known.count += 1;
    else counted.set(key, { ...rest, at: null });
  }
  notCaptured.push(...counted.values());
  const manifestGuards: Guard[] = [...guards.values()].map(({ fn, argument, shown, dropped, kept }) => {
    if (dropped + kept === 0) {
      throw new Error(`--guard ${fn}:${argument}=${shown}: no trap variant of that argument was generated, so the guard decides nothing. Check the function name and the argument index.`);
    }
    return { fn, argument, guard: shown, dropped, kept };
  });

  // Cases are grouped by function, in order of first appearance.
  const recordedInputs = evaluated.filter((entry) => entry.result !== undefined);
  const traps = recordedInputs.filter((entry) => entry.input.kind === 'trap').length;
  const cases: RecordedCase[] = [];
  for (const fn of functions) {
    const own: Case[] = [
      ...observed.cases.filter((entry) => entry.fn === fn),
      ...recordedInputs.filter((entry) => entry.input.fn === fn)
        .map((entry): Case => ({ fn, args: entry.input.args, result: entry.result!, origin: entry.input.origin })),
    ];
    own.forEach((entry, index) => cases.push({ ...entry, id: `${fn}#${index}` }));
  }
  const module = shownPath(options.repoRoot, modulePath);
  const review = [
    `recorded ${module}: ${cases.length} cases (${observed.cases.length} from tests, ${traps} trap variants, ${recordedInputs.length - traps} inputs)`,
    ...manifestGuards.map((guard) => `  guard ${guard.guard} on ${guard.fn} argument ${guard.argument}: dropped ${guard.dropped} of ${guard.dropped + guard.kept} trap variants`),
    ...noise.map((line) => `  noise: ${line}`),
    ...notCaptured.map((entry) => `  not captured: ${entry.fn} (${entry.where} ${entry.path}: ${entry.type}) x${entry.count}${entry.at ? ` at ${entry.at}` : ''}`),
  ];
  return {
    modulePath,
    cases,
    manifest: {
      module,
      tests: options.tests,
      inputs: inputsPath ? relative(options.repoRoot, inputsPath) : null,
      guards: manifestGuards,
      notCaptured,
    },
    review,
  };
}
