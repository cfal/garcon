import { readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, relative, resolve } from 'node:path';
import { isObject, wildcardPaths, type Json } from '../wildcard.js';
import { callKey, mergeCaptured, sameJson, type CaptureRecord, type Case, type Guard, type GuardSpec, type JsonArgument, type Manifest, type NotCaptured, type RecordedCase } from './cases.js';
import { INSTANCES_VARIABLE, normalizeInputStrings, recordLine, type EncodeFailure } from './encode.js';
import { runWithRecordStream, type StreamRun } from './process.js';
import { candidateVariants, MAX_VARIANTS_PER_FUNCTION, type Variant } from './traps.js';

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

// A call the evaluator makes.
export interface EvaluationInput {
  fn: string;
  args: Json[];
}

// A call to make in a fresh process: a trap variant of a recorded call, or a
// line of the inputs file.
export interface Input extends EvaluationInput {
  kind: 'trap' | 'input';
  // `trap:<name>@<path>`, or `<inputs file>:<line>`.
  origin: string;
  // The guard that was asked whether a trap variant is recorded at all.
  guard?: { argument: number; spec: string };
}

// What one evaluation run observed for one input.
export type Evaluation =
  | { result: Json }
  | { notCaptured: EncodeFailure }
  | { missing: true }
  | { timedOut: true };

// A fixed time zone and locale keep recordings comparable across machines.
// The Bun that runs the recorder comes first on PATH, so that a test or a
// module which starts `bun` by name runs on the same one (ADR-026).
function childEnvironment(variables: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    TZ: 'UTC',
    LANG: 'C.UTF-8',
  };
  delete environment.LC_ALL;
  return { ...environment, ...variables };
}

function childFailure(title: string, run: StreamRun): Error {
  return new Error(`${title}\n\n${run.output.trimEnd()}`);
}

// Runs each test file in its own process, as the repository runs them, and
// returns every call the tests made to the module's function exports.
export async function captureTests(repoRoot: string, modulePath: string, tests: string[], instances = false): Promise<CaptureRecord[]> {
  const records: CaptureRecord[] = [];
  for (const test of tests) {
    const file = resolve(repoRoot, test);
    const batch: CaptureRecord[] = [];
    const run = await runWithRecordStream([process.execPath, 'test', '--max-concurrency=1', '--preload', PRELOAD, file], childEnvironment({
      [MODULE_VARIABLE]: modulePath,
      [RECORD_STREAM_VARIABLE]: '3',
      [ROOT_VARIABLE]: repoRoot,
      [INSTANCES_VARIABLE]: instances ? '1' : '0',
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

// Runs the evaluator over `lines`, in order, and returns what it wrote for
// each of them. A line whose call stalls gets `stalled`; its process ends, and
// the run resumes with the lines after it.
async function evaluateLines<T>(
  modulePath: string,
  lines: readonly string[],
  stallMs: number,
  read: (record: Json) => T,
  stalled: T,
  instances = false,
): Promise<T[]> {
  const answers: T[] = [];
  while (answers.length < lines.length) {
    const remaining = lines.length - answers.length;
    const received: T[] = [];
    let open = true;
    const run = await runWithRecordStream([process.execPath, EVALUATOR, modulePath], childEnvironment({
      [EVALUATE_STREAM_VARIABLE]: '3',
      [INSTANCES_VARIABLE]: instances ? '1' : '0',
    }), {
      stdin: lines.slice(answers.length).join(''),
      stallMs,
      onRecord: (record) => {
        if (open) received.push(read(record));
      },
    });
    open = false;
    if (run.malformed) throw new Error(`The unit evaluator wrote a malformed record: ${run.malformed}`);
    answers.push(...received);
    if (!run.stalled) {
      if (received.length !== remaining) {
        throw childFailure(`The unit evaluator stopped after ${received.length} of ${remaining} inputs (exit code ${run.code}).`, run);
      }
      break;
    }
    // The inputs run in order, so the one that stalled is the first without an answer.
    if (answers.length < lines.length) answers.push(stalled);
  }
  return answers;
}

// Calls the module's exports with the inputs, in order, in a fresh process,
// and returns each outcome.
export async function evaluateInputs(
  modulePath: string, inputs: ReadonlyArray<EvaluationInput>, stallMs = EVALUATE_STALL_MS, instances = false,
): Promise<Evaluation[]> {
  return evaluateLines(modulePath, inputs.map(recordLine), stallMs, (record) => {
    if (!isObject(record) || !['result', 'notCaptured', 'missing'].some((key) => key in record)) {
      throw new Error('malformed evaluation');
    }
    return record as unknown as Evaluation;
  }, { timedOut: true }, instances);
}

// What a guard did with a trap variant of its argument.
export type Verdict = 'kept' | 'dropped' | 'stalled';

// Asks the guard of each input, in a fresh process and without calling the
// original, and returns whether it kept or dropped the variant. A guard that
// gives no answer in time counts as stalled.
export async function askGuards(modulePath: string, inputs: ReadonlyArray<Input>, stallMs = EVALUATE_STALL_MS): Promise<Verdict[]> {
  return evaluateLines(modulePath, inputs.map((input) => recordLine({ ...input, guardOnly: true })), stallMs, (record) => {
    if (!isObject(record) || typeof record.guarded !== 'boolean') throw new Error('malformed evaluation');
    return record.guarded ? 'dropped' : 'kept';
  }, 'stalled');
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
    inputs.push({ fn: entry.fn, args: entry.args.map(normalizeInputStrings), kind: 'input', origin: `${relative(repoRoot, path)}:${index + 1}` });
  }
  return inputs;
}

interface MergedEvaluation {
  result?: Json;
  notCaptured?: NotCaptured;
  noise: string[];
}

// Merges the two evaluation runs of one input.
function mergeEvaluation(input: Input, first: Evaluation, second: Evaluation, stallMs: number): MergedEvaluation {
  const label = `${input.fn} (${JSON.stringify(input.args).slice(0, 80)}) [${input.origin}]`;
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
  // Arguments that reach a port as JSON even when they are a number: NaN and
  // the infinities are not made for them, since JSON cannot carry them.
  jsonArguments?: JsonArgument[];
  instances?: true;
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

// The trap candidates of one function, and the variants kept so far.
interface Plan {
  fn: string;
  candidates: Generator<Variant>;
  inputs: Input[];
  exhausted: boolean;
}

// Guards are keyed by the function and the argument they guard.
type GuardTable = Map<string, CountedGuard>;

const guardKey = (fn: string, argument: number): string => JSON.stringify([fn, argument]);

// A guard of another file than the recorded module is written `<file>#<export>`.
function guardParts(guard: string): { file: string | null; name: string } {
  const hash = guard.indexOf('#');
  return hash === -1 ? { file: null, name: guard } : { file: guard.slice(0, hash), name: guard.slice(hash + 1) };
}

async function countedGuards(repoRoot: string, specs: readonly GuardSpec[]): Promise<GuardTable> {
  const guards: GuardTable = new Map();
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

// Fills a function with trap variants, up to MAX_VARIANTS_PER_FUNCTION. Each
// variant of a guarded argument is kept only when the original's guard accepts
// it. Candidates keep coming, in their order, until the function has its fill
// or they run out, so a guard costs a function none of the variants a port can
// receive. `known` receives every variant that is kept, so that an explicit
// input equal to it is not repeated.
async function fillPlan(
  modulePath: string,
  plan: Plan,
  guards: ReadonlyMap<number, CountedGuard>,
  known: Set<string>,
  stallMs: number,
  noise: string[],
): Promise<void> {
  while (plan.inputs.length < MAX_VARIANTS_PER_FUNCTION && !plan.exhausted) {
    const batch: Array<{ variant: Variant; input: Input }> = [];
    const remaining = MAX_VARIANTS_PER_FUNCTION - plan.inputs.length;
    while (batch.length < remaining) {
      const next = plan.candidates.next();
      if (next.done) {
        plan.exhausted = true;
        break;
      }
      const variant = next.value;
      const guard = guards.get(variant.argument);
      batch.push({
        variant,
        input: { fn: plan.fn, args: variant.args, kind: 'trap', origin: variant.origin, ...(guard ? { guard: { argument: variant.argument, spec: guard.spec } } : {}) },
      });
    }
    const asked = batch.filter((entry) => entry.input.guard !== undefined);
    const guarded = asked.map((entry) => entry.input);
    const first = await askGuards(modulePath, guarded, stallMs);
    const second = await askGuards(modulePath, guarded, stallMs);
    let index = 0;
    for (const { variant, input } of batch) {
      if (input.guard === undefined) {
        plan.inputs.push(input);
        known.add(callKey(plan.fn, input.args));
        continue;
      }
      const guard = guards.get(variant.argument)!;
      const a = first[index];
      const b = second[index++];
      if (a !== b && a !== 'stalled' && b !== 'stalled') {
        throw new Error(`A guard of ${plan.fn} did not decide the same way in both runs: ${variant.origin}.`);
      }
      const verdict = a === 'stalled' || b === 'stalled' ? 'stalled' : a;
      if (verdict === 'kept') guard.kept += 1;
      else guard.dropped += 1;
      if (verdict === 'stalled') noise.push(`${variant.origin} (${plan.fn}): its guard gave no answer within ${stallMs} ms; not recorded`);
      if (verdict === 'kept') {
        plan.inputs.push(input);
        known.add(callKey(plan.fn, input.args));
      }
    }
  }
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
    await captureTests(options.repoRoot, modulePath, options.tests, options.instances),
    await captureTests(options.repoRoot, modulePath, options.tests, options.instances),
  );
  const inputsPath = options.inputs ? resolve(options.repoRoot, options.inputs) : null;
  const explicit = inputsPath ? await readInputs(options.repoRoot, inputsPath) : [];
  if (observed.cases.length === 0 && explicit.length === 0) {
    throw new Error(`No call to a function export of ${options.module} was captured. The tests must import it and call its exports.`);
  }

  const functions = [...new Set([...observed.cases, ...explicit].map((entry) => entry.fn))];
  const known = new Set(observed.cases.map((entry) => callKey(entry.fn, entry.args)));
  // Every candidate generated, so that none is generated twice.
  const generated = new Set<string>();
  const jsonArguments = options.jsonArguments ?? [];
  for (const { fn, argument } of jsonArguments) {
    if (!functions.includes(fn)) throw new Error(`--json ${fn}:${argument}: no call to a function of that name was recorded.`);
  }
  const noise = [...observed.noise];
  const stallMs = options.stallMs ?? EVALUATE_STALL_MS;
  const plans: Plan[] = functions.map((fn) => ({
    fn,
    candidates: candidateVariants(
      observed.cases.filter((entry) => entry.fn === fn).map((entry) => entry.args),
      (args) => {
        const key = callKey(fn, args);
        if (known.has(key) || generated.has(key)) return true;
        generated.add(key);
        return false;
      },
      new Set(jsonArguments.filter((entry) => entry.fn === fn).map((entry) => entry.argument)),
    ),
    inputs: [],
    exhausted: false,
  }));
  for (const plan of plans) {
    const own = new Map([...guards.values()].filter((guard) => guard.fn === plan.fn).map((guard) => [guard.argument, guard]));
    await fillPlan(modulePath, plan, own, known, stallMs, noise);
  }
  const inputs: Input[] = plans.flatMap((plan) => plan.inputs);
  for (const input of explicit) {
    if (known.has(callKey(input.fn, input.args))) {
      noise.push(`${input.fn} (${JSON.stringify(input.args).slice(0, 80)}) [${input.origin}]: equals a recorded case; not repeated`);
      continue;
    }
    inputs.push(input);
  }

  const first = await evaluateInputs(modulePath, inputs, stallMs, options.instances);
  const second = await evaluateInputs(modulePath, inputs, stallMs, options.instances);
  const evaluated = inputs.map((input, index) => ({ input, ...mergeEvaluation(input, first[index]!, second[index]!, stallMs) }));
  const notCaptured = [...observed.notCaptured];
  // Inputs that could not be encoded have no call site to name, so they are
  // counted per function and reason.
  const counted = new Map<string, NotCaptured>();
  for (const entry of evaluated) {
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
      jsonArguments,
      ...(options.instances ? { instances: true as const } : {}),
      bunVersion: Bun.version,
      notCaptured,
    },
    review,
  };
}
