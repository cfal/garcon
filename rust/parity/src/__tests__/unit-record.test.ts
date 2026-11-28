import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { sameJson, writeCases, type CaptureRecord, type GuardSpec, type JsonArgument, type RecordedCase } from '../unit/cases.js';
import { encodeString } from '../unit/encode.js';
import { askGuards, captureTests, evaluateInputs, recordUnit, type Input } from '../unit/record.js';
import { replayCases, replayUnit } from '../unit/replay.js';
import { MAX_VARIANTS_PER_FUNCTION } from '../unit/traps.js';
import { isLabel, isTag } from './fixtures/unit/typed.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const fixture = (name: string) => `rust/parity/src/__tests__/fixtures/unit/${name}`;
// A manifest written by hand names the Bun that runs the tests, as the recorder does.
const bunVersion = Bun.version;

test('records argument snapshots before sync, async and constructor calls mutate them', async () => {
  const module = fixture('mutations.ts');
  const recording = await recordUnit({ repoRoot, module, tests: [fixture('mutations.calls.ts')], instances: true });
  expect(recording.cases.filter((entry) => entry.origin === 'test').map(({ fn, args }) => [fn, args])).toEqual([
    ['mutate', [{ count: 3 }]],
    ['mutateLater', [{ count: 4 }]],
    ['new MutatingConstructor', [{ count: 5 }]],
  ]);
  expect((await replayCases(recording.modulePath, recording.cases, module, true)).cases.filter((entry) => entry.difference)).toEqual([]);
});

test('records a prototype lookup and reports inherited functions as not captured', async () => {
  const recording = await recordUnit({ repoRoot, module: fixture('lookup.ts'), tests: [fixture('lookup.calls.ts')] });
  expect(recording.cases.find((entry) => entry.args[0] === '__proto__')?.result).toEqual({});
  expect(recording.manifest.notCaptured).toEqual([
    { fn: 'lookup', where: 'result', path: '$.result', type: 'a function', at: null, count: 3 },
  ]);
});

test('keeps Unicode separators and an ordinary newline framed through capture and replay', async () => {
  const module = fixture('recorded-values.ts');
  const recording = await recordUnit({ repoRoot, module, tests: [fixture('recorded-values.calls.ts')] });
  const marked = encodeString('a\ud800b\udc00');
  const separators = 'first\u2028second\u2029third\nfourth';
  expect(recording.cases).toContainEqual(expect.objectContaining({ fn: 'echo', args: [separators], result: separators, origin: 'test' }));
  expect(recording.cases).toContainEqual(expect.objectContaining({ fn: 'echo', args: [marked], result: marked, origin: 'test' }));
  expect(recording.cases).toContainEqual(expect.objectContaining({
    fn: 'echo', args: [{ $: 'object-entries', value: [[marked, marked]] }],
    result: { $: 'object-entries', value: [[marked, marked]] }, origin: 'test',
  }));
  expect(recording.manifest.notCaptured.some((entry) => entry.fn === 'reply' && entry.where === 'result')).toBe(true);
  expect((await replayCases(recording.modulePath, recording.cases, module)).cases.filter((entry) => entry.difference)).toEqual([]);
});

test('records exact surrogate units in input-file arguments without wildcarding them', async () => {
  const directory = await temporary();
  const inputs = join(directory, 'unicode.jsonl');
  await writeFile(inputs, JSON.stringify({ fn: 'echo', args: ['\ud800'] }) + '\n');
  const recording = await recordUnit({ repoRoot, module: fixture('recorded-values.ts'), tests: [], inputs });
  expect(recording.cases[0]).toMatchObject({
    args: [{ $: 'utf16', value: [0xd800], text: '\ufffd' }],
    result: { $: 'utf16', value: [0xd800], text: '\ufffd' },
  });
  expect(() => sameJson({ value: encodeString('\ud800') }, { value: encodeString('\ud801') }))
    .toThrow('UTF-16 code units differ across runs at $.result.value');
});

test('records returned class instances recursively with the opt-in and replays it from the manifest', async () => {
  const module = fixture('recorded-values.ts');
  const directory = await temporary();
  const recording = await recordUnit({ repoRoot, module, tests: [fixture('recorded-values.calls.ts')], instances: true });
  expect(recording.cases.find((entry) => entry.fn === 'reply' && entry.origin === 'test')?.result).toEqual({
    $: 'instance', name: 'Reply', fields: {
      optional: { $: 'undefined' }, nested: [{ $: 'instance', name: 'Child', fields: { label: encodeString('a\ud800b\udc00') } }],
    },
  });
  expect(recording.manifest.notCaptured.some((entry) => entry.fn === 'classArgument' && entry.where === 'args')).toBe(true);
  expect(await writeCases(directory, recording.cases, recording.manifest)).toMatchObject({ instances: true });
  expect((await replayUnit(repoRoot, directory)).cases.filter((entry) => entry.difference)).toEqual([]);
});
// The trap cases that change argument `argument` of calls to `fn`.
function trapsOf(cases: RecordedCase[], fn: string, argument: number): RecordedCase[] {
  return cases.filter((entry) => entry.fn === fn && entry.origin.startsWith('trap:') && entry.origin.includes(`@$.args[${argument}]`));
}

// Cases without their ids, which shift when cases before them are dropped.
function withoutIds(cases: RecordedCase[]) {
  return cases.map(({ id: _id, ...rest }) => rest);
}

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-unit-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const line = (record: CaptureRecord): string => 'notCaptured' in record
  ? `${record.fn}! ${record.notCaptured.where} ${record.notCaptured.path}: ${record.notCaptured.type} at ${record.notCaptured.at}`
  : `${record.fn} ${JSON.stringify(record.args)} => ${JSON.stringify(record.result)}`;

const undefinedMarker = { $: 'undefined' };

describe('captureTests', () => {
  test('records every call to function declarations: returned, thrown, async, and from another export', async () => {
    const records = await captureTests(repoRoot, resolve(repoRoot, fixture('functions.ts')), [fixture('functions.calls.ts')]);
    expect(records.map(line)).toEqual([
      'join [["a","b"]] => "a,b"',
      'join [["a","b"],"."] => "a.b"',
      'shout ["hi"] => "HI!"',
      // `shout` calls `upper` through the module's binding.
      'upper ["hi"] => "HI"',
      `echo [${JSON.stringify(undefinedMarker)}] => ${JSON.stringify(undefinedMarker)}`,
      `echo [{"when":{"$":"date","value":"1970-01-01T00:00:00.000Z"},"tags":{"$":"set","value":["x"]}}] => {"when":{"$":"date","value":"1970-01-01T00:00:00.000Z"},"tags":{"$":"set","value":["x"]}}`,
      `kinds [] => ${JSON.stringify([
        undefinedMarker, { $: 'number', value: 'NaN' }, { $: 'number', value: 'Infinity' }, { $: 'number', value: '-Infinity' }, { $: 'number', value: '-0' },
        { $: 'date', value: '2026-11-27T10:11:12.000Z' }, { $: 'map', value: [['a', 1]] }, { $: 'set', value: [1, 2] },
        { $: 'bytes', value: 'AQID' }, { $: 'bytes', value: 'aGk=', buffer: true }, { $: 'bigint', value: '10' },
      ])}`,
      'reject ["E_X"] => {"$":"error","name":"Error","message":"rejected E_X","properties":{"code":"E_X","status":418}}',
      'refuse ["plain"] => {"$":"throw","value":"plain"}',
      'later ["z"] => "later z"',
      'wrap! result $.result: a Thing instance at rust/parity/src/__tests__/fixtures/unit/functions.calls.ts:16:10',
      'new Thing! result $.result: a Thing instance at rust/parity/src/__tests__/fixtures/unit/functions.calls.ts:16:10',
      'make! result $.result: a function at rust/parity/src/__tests__/fixtures/unit/functions.calls.ts:17:10',
    ]);
  });

  test('passes value exports through and records the functions beside them', async () => {
    const records = await captureTests(repoRoot, resolve(repoRoot, fixture('values.ts')), [fixture('values.calls.ts')]);
    expect(records.map(line)).toEqual([
      'versionLabel [] => "v3"',
      'limited [["a","b","c"]] => "a,b"',
      // `join` belongs to another module, which is not the one recorded.
      'count [["a"]] => 0.5',
    ]);
  });

  test('records the static methods and constructors of a class, and lists its instances', async () => {
    const records = await captureTests(repoRoot, resolve(repoRoot, fixture('classes.ts')), [fixture('classes.calls.ts')]);
    expect(records.map(line)).toEqual([
      'Ticket.parse ["t"] => {"text":"t","kind":"ticket"}',
      'Ticket.parse [""] => null',
      'new Ticket! result $.result: a Ticket instance at rust/parity/src/__tests__/fixtures/unit/classes.calls.ts:9:14',
      'new Ticket! result $.result: a Ticket instance at rust/parity/src/__tests__/fixtures/unit/classes.calls.ts:10:14',
      'new Ticket ["throws"] => {"$":"error","name":"RangeError","message":"bad text","properties":{}}',
      'Ticket.fail ["E_X"] => {"$":"error","name":"DomainError","message":"failed E_X","properties":{"code":"E_X","status":400}}',
      // `Ticket.fail` constructs the other export through the module's binding.
      'new DomainError ["failed E_X","E_X"] => {"$":"error","name":"DomainError","message":"failed E_X","properties":{"code":"E_X","status":400}}',
      'Ticket.parse ["u"] => {"text":"u","kind":"ticket"}',
    ]);
  });

  test('stops at a test file that fails, with its output', async () => {
    await expect(captureTests(repoRoot, resolve(repoRoot, fixture('functions.ts')), [fixture('failing.calls.ts')]))
      .rejects.toThrow(/bun test .*failing\.calls\.ts exited with code 1\. Record passing tests: a failing test's calls are not evidence\.[\s\S]*Expected: "a;b"\nReceived: "a,b"/);
  });

  test('starts the tests and the evaluator with the Bun that runs the recorder, first on their PATH', async () => {
    // Another `bun` earlier on the harness's own PATH must not be the one the recording runs on (ADR-026).
    const harnessPath = process.env.PATH;
    const other = await temporary();
    const decoy = join(other, 'bun');
    await writeFile(decoy, '#!/bin/sh\necho another bun\n');
    await chmod(decoy, 0o755);
    process.env.PATH = `${other}${delimiter}${harnessPath ?? ''}`;
    try {
      const modulePath = resolve(repoRoot, fixture('runtime.ts'));
      const runsOn = JSON.stringify([Bun.version, process.execPath]);
      expect((await captureTests(repoRoot, modulePath, [fixture('runtime.calls.ts')])).map(line)).toEqual([`runtime [] => ${runsOn}`]);
      expect(await evaluateInputs(modulePath, [{ fn: 'runtime', args: [] }])).toEqual([{ result: [Bun.version, process.execPath] }]);
    } finally {
      if (harnessPath === undefined) delete process.env.PATH;
      else process.env.PATH = harnessPath;
    }
  });
});

describe('recordUnit', () => {
  test('records the tests, trap variants, and inputs, and the original replays it', async () => {
    const directory = await temporary();
    const inputs = join(directory, 'inputs.jsonl');
    await writeFile(inputs, `${[
      JSON.stringify({ fn: 'join', args: [['x', 'y'], '-'] }),
      JSON.stringify({ fn: 'join', args: [['a', 'b'], '.'] }),
      JSON.stringify({ fn: 'kinds', args: [] }),
    ].join('\n')}\n`);
    const recording = await recordUnit({
      repoRoot,
      module: fixture('functions.ts'),
      tests: [fixture('functions.calls.ts')],
      inputs,
    });
    expect(recording.review[0]).toMatch(/^recorded .*fixtures\/unit\/functions\.ts: \d+ cases \(10 from tests, \d+ trap variants, 1 inputs\)$/);
    // Nothing differed between the two runs of either kind; the inputs that
    // equal a recorded call are named.
    expect(recording.review.filter((entry) => entry.includes('noise:'))).toEqual([
      `  noise: join ([["a","b"],"."]) [${relative(repoRoot, inputs)}:2]: equals a recorded case; not repeated`,
      `  noise: kinds ([]) [${relative(repoRoot, inputs)}:3]: equals a recorded case; not repeated`,
    ]);
    const callsFile = 'rust/parity/src/__tests__/fixtures/unit/functions.calls.ts';
    expect(recording.manifest).toEqual({
      module: fixture('functions.ts'),
      tests: [callsFile],
      inputs: relative(repoRoot, inputs),
      guards: [],
      jsonArguments: [],
      bunVersion,
      notCaptured: [
        { fn: 'wrap', where: 'result', path: '$.result', type: 'a Thing instance', count: 1, at: `${callsFile}:16:10` },
        { fn: 'new Thing', where: 'result', path: '$.result', type: 'a Thing instance', count: 1, at: `${callsFile}:16:10` },
        { fn: 'make', where: 'result', path: '$.result', type: 'a function', count: 1, at: `${callsFile}:17:10` },
      ],
    });

    // Cases are grouped by function and numbered within it.
    const groups = new Map<string, number>();
    for (const entry of recording.cases) groups.set(entry.fn, (groups.get(entry.fn) ?? 0) + 1);
    const order = recording.cases.map((entry) => entry.fn);
    expect([...new Set(order)]).toEqual([...groups.keys()]);
    for (const [fn, count] of groups) {
      expect(recording.cases.filter((entry) => entry.fn === fn).map((entry) => entry.id)).toEqual(
        Array.from({ length: count }, (_, index) => `${fn}#${index}`),
      );
    }
    // The input equal to a recorded call (`join(['a', 'b'], '.')`) is not repeated.
    expect(recording.cases.filter((entry) => entry.origin.startsWith(relative(repoRoot, inputs))).map((entry) => [entry.origin.slice(-'inputs.jsonl:1'.length), entry.args])).toEqual([
      ['inputs.jsonl:1', [['x', 'y'], '-']],
    ]);

    const result = await replayCases(recording.modulePath, recording.cases, 'functions.ts');
    expect(result.cases.filter((entry) => entry.difference)).toEqual([]);
  });

  test('records from an inputs file alone, with markers decoded for the original', async () => {
    const directory = await temporary();
    const inputs = join(directory, 'inputs.jsonl');
    await writeFile(inputs, `${[
      JSON.stringify({ fn: 'echo', args: [{ $: 'map', value: [['k', { $: 'number', value: '-0' }]] }] }),
      JSON.stringify({ fn: 'refuse', args: ['no'] }),
    ].join('\n')}\n`);
    const recording = await recordUnit({ repoRoot, module: fixture('functions.ts'), tests: [], inputs });
    expect(recording.cases.map((entry) => [entry.fn, entry.origin, entry.result])).toEqual([
      ['echo', `${relative(repoRoot, inputs)}:1`, { $: 'map', value: [['k', { $: 'number', value: '-0' }]] }],
      ['refuse', `${relative(repoRoot, inputs)}:2`, { $: 'throw', value: 'no' }],
    ]);
    await writeFile(inputs, `${JSON.stringify({ fn: 'nope', args: [] })}\n`);
    await expect(recordUnit({ repoRoot, module: fixture('functions.ts'), tests: [], inputs }))
      .rejects.toThrow('The original does not export a function the inputs call: nope.');
  });

  test('gives up on a call that never returns, synchronously or not, and goes on', async () => {
    const modulePath = resolve(repoRoot, fixture('functions.ts'));
    const evaluations = await evaluateInputs(modulePath, [
      { fn: 'forever', args: [] },
      { fn: 'never', args: [] },
      { fn: 'join', args: [['a', 'b']] },
    ], 500);
    expect(evaluations).toEqual([{ timedOut: true }, { timedOut: true }, { result: 'a,b' }]);
  });

  test('lists a call that never returns instead of recording it', async () => {
    const directory = await temporary();
    const inputs = join(directory, 'inputs.jsonl');
    await writeFile(inputs, `${JSON.stringify({ fn: 'forever', args: [] })}\n${JSON.stringify({ fn: 'join', args: [['a', 'b']] })}\n`);
    const recording = await recordUnit({ repoRoot, module: fixture('functions.ts'), tests: [], inputs, stallMs: 500 });
    expect(recording.cases.map((entry) => entry.result)).toEqual(['a,b']);
    expect(recording.review.slice(1)).toEqual(['  not captured: forever (result $.result: no outcome within 500 ms) x1']);
  });

  test('wildcards a result that differs between the two runs and reports it', async () => {
    const directory = await temporary();
    const inputs = join(directory, 'inputs.jsonl');
    await writeFile(inputs, `${JSON.stringify({ fn: 'roll', args: [] })}\n${JSON.stringify({ fn: 'label', args: [6] })}\n`);
    const recording = await recordUnit({ repoRoot, module: fixture('random.ts'), tests: [], inputs });
    expect(recording.cases.map((entry) => [entry.fn, entry.result])).toEqual([['roll', '[..]'], ['label', 'd6']]);
    expect(recording.review.slice(1)).toEqual([`  noise: roll ([]) [${relative(repoRoot, inputs)}:1]: differs between runs at $.result`]);
  });

  test('refuses a module whose tests call none of its function exports', async () => {
    await expect(recordUnit({ repoRoot, module: fixture('silent.ts'), tests: [fixture('silent.calls.ts')] }))
      .rejects.toThrow('No call to a function export of rust/parity/src/__tests__/fixtures/unit/silent.ts was captured. The tests must import it and call its exports.');
    await expect(recordUnit({ repoRoot, module: fixture('missing.ts'), tests: [] }))
      .rejects.toThrow('Not a file: rust/parity/src/__tests__/fixtures/unit/missing.ts');
  });
});

describe('numbers JSON cannot carry', () => {
  const record = (jsonArguments?: JsonArgument[]) => recordUnit({ repoRoot, module: fixture('typed.ts'), tests: [fixture('typed.calls.ts')], jsonArguments });

  test('replace a number only where it is the whole argument', async () => {
    const { cases } = await record();
    // A port receives `count` as the exact JavaScript number.
    const nan = { $: 'number', value: 'NaN' };
    const infinity = { $: 'number', value: 'Infinity' };
    const negativeInfinity = { $: 'number', value: '-Infinity' };
    expect(trapsOf(cases, 'triple', 0).map((entry) => [entry.args[0], entry.result]).slice(-3)).toEqual([
      [nan, nan], [infinity, infinity], [negativeInfinity, negativeInfinity],
    ]);
    // A number inside an object reaches a port as JSON, so it keeps to what
    // JSON holds; negative zero is kept as the marker a port reads as `-0.0`.
    const nested = trapsOf(cases, 'total', 0);
    expect(nested.map((entry) => entry.origin.slice(5, entry.origin.indexOf('@')))).toEqual([
      'zero', 'zero', 'negative-zero', 'negative-zero', 'negative-one', 'negative-one',
      'half', 'half', '1e21', '1e21', '1e-7', '1e-7', '2^53', '2^53',
    ]);
    expect(nested[2].args).toEqual([{ first: { $: 'number', value: '-0' }, second: 2 }]);
  });

  test('are not made for an argument declared JSON, while a call the tests made with one is still recorded', async () => {
    // The ports of `triple` and of `half` read the argument as JSON, where NaN and the infinities cannot reach them.
    const declared: JsonArgument[] = [{ fn: 'triple', argument: 0 }, { fn: 'half', argument: 0 }];
    const { cases, manifest } = await record(declared);
    expect(manifest.jsonArguments).toEqual(declared);
    expect(trapsOf(cases, 'triple', 0).map((entry) => entry.origin.slice(5, entry.origin.indexOf('@')))).toEqual([
      'zero', 'negative-zero', 'negative-one', 'half', '1e21', '1e-7', '2^53',
    ]);
    expect(trapsOf(cases, 'half', 0)).toHaveLength(7);
    const nonFinite = (entry: RecordedCase) => entry.origin.startsWith('trap:') && /:(nan|infinity|negative-infinity)@/.test(entry.origin);
    expect(cases.filter((entry) => entry.fn === 'triple' || entry.fn === 'half').filter(nonFinite)).toEqual([]);
    // A function whose number argument is not declared keeps them.
    expect(trapsOf(cases, 'tagOf', 0).filter(nonFinite)).toHaveLength(3);
    // What the tests themselves passed is recorded as it was. The reader of such
    // an argument in the port then fails the case and asks for a decision.
    const nan = { $: 'number', value: 'NaN' };
    expect(cases.find((entry) => entry.fn === 'half' && entry.origin === 'test')).toMatchObject({ args: [nan], result: nan });
    // A function whose arguments are not declared keeps every trap.
    expect(trapsOf(cases, 'labelOf', 0)).toHaveLength(MAX_VARIANTS_PER_FUNCTION);
  });

  test('refuse a declaration for a function that no call records', async () => {
    await expect(record([{ fn: 'nope', argument: 0 }])).rejects.toThrow('--json nope:0: no call to a function of that name was recorded.');
  });
});

describe('a guard', () => {
  const typed = fixture('typed.ts');
  const tests = [fixture('typed.calls.ts')];
  const record = (guards: GuardSpec[]) => recordUnit({ repoRoot, module: typed, tests, guards });
  const own = { fn: 'tagOf', argument: 0, guard: 'isTag' };

  test('keeps only the trap variants of its argument that the original accepts, and counts the rest as dropped', async () => {
    const plain = await record([]);
    const guarded = await record([own]);
    // Without the guard, the first 60 candidates of `tagOf` hold 39 variants of
    // argument 0. With it the candidates run out, and `isTag`
    // accepts 21 of the 55 it is asked about.
    expect(trapsOf(plain.cases, 'tagOf', 0)).toHaveLength(39);
    const kept = trapsOf(guarded.cases, 'tagOf', 0);
    expect(kept).toHaveLength(21);
    for (const entry of kept) expect(isTag(entry.args[0])).toBe(true);
    // NaN and the infinities are numbers, which the guard rejects.
    expect(kept.filter((entry) => /:(nan|infinity|negative-infinity)@/.test(entry.origin))).toEqual([]);
    expect(guarded.manifest.guards).toEqual([{ ...own, dropped: 34, kept: 21 }]);
    expect(guarded.review[1]).toBe('  guard isTag on tagOf argument 0: dropped 34 of 55 trap variants');
    expect(plain.manifest.guards).toEqual([]);
    // A call the tests made stays, also one the guard rejects.
    const testCalls = guarded.cases.filter((entry) => entry.origin === 'test').map((entry) => entry.args);
    expect(testCalls).toEqual(plain.cases.filter((entry) => entry.origin === 'test').map((entry) => entry.args));
    expect(testCalls).toContainEqual(['a tag longer than eight']);
    expect(testCalls).toContainEqual([3, 'none']);
    // So does every variant of the other argument, in the candidates' order,
    // and every case of the other functions.
    const other = trapsOf(guarded.cases, 'tagOf', 1);
    const unguarded = trapsOf(plain.cases, 'tagOf', 1);
    expect(other).toHaveLength(29);
    expect(withoutIds(other.slice(0, unguarded.length))).toEqual(withoutIds(unguarded));
    expect(withoutIds(guarded.cases.filter((entry) => entry.fn !== 'tagOf'))).toEqual(withoutIds(plain.cases.filter((entry) => entry.fn !== 'tagOf')));
    const result = await replayCases(guarded.modulePath, guarded.cases, 'typed.ts');
    expect(result.cases.filter((entry) => entry.difference)).toEqual([]);
  });

  test('costs a function none of its budget: candidates keep coming until 60 are accepted or run out', async () => {
    // Ten calls share the argument of `labelOf`, and `isLabel` rejects more than half of their variants.
    const label = { fn: 'labelOf', argument: 0, guard: 'isLabel' };
    const plain = await record([]);
    const guarded = await record([label]);
    const kept = trapsOf(guarded.cases, 'labelOf', 0);
    // As many as without a guard, and every one a label.
    expect(kept).toHaveLength(MAX_VARIANTS_PER_FUNCTION);
    for (const entry of kept) expect(isLabel(entry.args[0])).toBe(true);
    // The first 60 candidates alone would have left the function short. The
    // accepted ones among them come first, in the candidates' order.
    const firstBatch = trapsOf(plain.cases, 'labelOf', 0).filter((entry) => isLabel(entry.args[0]));
    expect(firstBatch.length).toBeGreaterThan(0);
    expect(firstBatch.length).toBeLessThan(MAX_VARIANTS_PER_FUNCTION);
    expect(withoutIds(kept.slice(0, firstBatch.length))).toEqual(withoutIds(firstBatch));
    expect(guarded.manifest.guards).toEqual([{ ...label, dropped: 101, kept: 60 }]);
    expect(guarded.review[1]).toBe('  guard isLabel on labelOf argument 0: dropped 101 of 161 trap variants');
    expect(withoutIds(guarded.cases.filter((entry) => entry.fn !== 'labelOf'))).toEqual(withoutIds(plain.cases.filter((entry) => entry.fn !== 'labelOf')));
  });

  test('rejects a variant also when the guard throws for it', async () => {
    // `isShortTag` throws for a number.
    const guarded = await record([{ ...own, guard: 'isShortTag' }]);
    expect(guarded.manifest.guards).toEqual([{ ...own, guard: 'isShortTag', dropped: 34, kept: 21 }]);
    expect(trapsOf(guarded.cases, 'tagOf', 0).every((entry) => typeof entry.args[0] === 'string')).toBe(true);
  });

  test('can be an export of another file', async () => {
    const guard = `${fixture('guard.ts')}#isTagOfAtMostEight`;
    const guarded = await record([{ ...own, guard }]);
    expect(guarded.manifest.guards).toEqual([{ ...own, guard, dropped: 34, kept: 21 }]);
  });

  test('is asked in a process of its own before anything is called, once per variant', async () => {
    const modulePath = resolve(repoRoot, typed);
    const variant = (args: Input['args'], spec = 'isTag'): Input => ({ fn: 'tagOf', args, kind: 'trap', origin: 'trap:zero@$.args[0]', guard: { argument: 0, spec } });
    expect(await askGuards(modulePath, [variant([3]), variant(['ab']), variant([{ $: 'number', value: 'NaN' }])])).toEqual(['dropped', 'kept', 'dropped']);
    // One that throws rejects, and one that never answers is given up; the run goes on with the next variant.
    expect(await askGuards(modulePath, [variant([3], 'isShortTag')], 500)).toEqual(['dropped']);
    expect(await askGuards(modulePath, [variant([''], 'stallsOnEmpty'), variant(['ab'], 'stallsOnEmpty')], 500)).toEqual(['stalled', 'kept']);
  });

  test('gives up on a variant whose guard never answers, leaves it out, and says so', async () => {
    const guarded = await recordUnit({ repoRoot, module: typed, tests, guards: [{ ...own, guard: 'stallsOnEmpty' }], stallMs: 500 });
    // One candidate within the function's budget holds the empty string.
    expect(guarded.review.filter((entry) => entry.includes('no answer'))).toEqual([
      '  noise: trap:empty@$.args[0] (tagOf): its guard gave no answer within 500 ms; not recorded',
    ]);
    expect(guarded.manifest.guards).toEqual([{ ...own, guard: 'stallsOnEmpty', dropped: 1, kept: 38 }]);
    expect(trapsOf(guarded.cases, 'tagOf', 0).some((entry) => entry.args[0] === '')).toBe(false);
  });

  test('is refused when no trap variant of its argument was generated', async () => {
    for (const guard of [{ ...own, fn: 'nope' }, { ...own, argument: 5 }]) {
      await expect(record([guard])).rejects.toThrow(`--guard ${guard.fn}:${guard.argument}=isTag: no trap variant of that argument was generated, so the guard decides nothing. Check the function name and the argument index.`);
    }
  });

  test('is refused when it is not an exported function', async () => {
    await expect(record([{ ...own, guard: 'notExported' }])).rejects.toThrow(/The guard is not an exported function: notExported/);
  });

  test('is refused for a file that is not there, and twice for one argument', async () => {
    const guard = `${fixture('missing.ts')}#isTag`;
    await expect(record([{ ...own, guard }])).rejects.toThrow(`--guard tagOf:0=${guard}: not a file: ${fixture('missing.ts')}`);
    await expect(record([own, { ...own, guard: 'isShortTag' }])).rejects.toThrow('Two guards for argument 0 of tagOf.');
  });
});

describe('replayUnit', () => {
  test('the original ignores Rust known differences beside its cases', async () => {
    const directory = await temporary();
    await writeCases(directory, [
      { id: 'join#0', fn: 'join', args: [['a', 'b']], result: 'a,b', origin: 'test' },
    ], { module: fixture('functions.ts'), tests: [], inputs: null, guards: [], jsonArguments: [], bunVersion, notCaptured: [] });
    await writeFile(join(directory, 'known-differences.jsonl'), '{"fn":"join","args":[["a","b"]],"result":"a;b","reason":"synthetic"}\n');
    expect((await replayUnit(repoRoot, directory)).cases[0]?.difference).toBeNull();
  });

  test('reports a result that differs from the recording, at its path', async () => {
    const directory = await temporary();
    await writeCases(directory, [
      { id: 'join#0', fn: 'join', args: [['a', 'b']], result: 'a;b', origin: 'test' },
      { id: 'join#1', fn: 'join', args: [['a', 'b']], result: 'a,b', origin: 'test' },
      { id: 'gone#0', fn: 'gone', args: [], result: null, origin: 'test' },
    ], { module: fixture('functions.ts'), tests: [], inputs: null, guards: [], jsonArguments: [], bunVersion, notCaptured: [] });
    const result = await replayUnit(repoRoot, directory);
    expect(result.cases.map((entry) => [entry.name, entry.difference?.path ?? null, entry.difference?.kind ?? null])).toEqual([
      ['join#0', '$', 'value'],
      ['join#1', null, null],
      ['gone#0', '$', 'type'],
    ]);
  });

  test('refuses an edited case file before calling anything', async () => {
    const directory = await temporary();
    await writeCases(directory, [
      { id: 'join#0', fn: 'join', args: [['a', 'b']], result: 'a,b', origin: 'test' },
    ], { module: fixture('functions.ts'), tests: [], inputs: null, guards: [], jsonArguments: [], bunVersion, notCaptured: [] });
    await writeFile(join(directory, 'cases.jsonl'), (await Bun.file(join(directory, 'cases.jsonl')).text()).replace('a,b', 'a;b'));
    await expect(replayUnit(repoRoot, directory)).rejects.toThrow('is not the recorded file');
  });
});
