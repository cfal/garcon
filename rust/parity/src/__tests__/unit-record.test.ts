import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { writeCases, type CaptureRecord, type GuardSpec, type RecordedCase } from '../unit/cases.js';
import { captureTests, evaluateInputs, mergeEvaluation, recordUnit, type Input } from '../unit/record.js';
import { replayCases, replayUnit } from '../unit/replay.js';
import { isTag } from './fixtures/unit/typed.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const fixture = (name: string) => `rust/parity/src/__tests__/fixtures/unit/${name}`;

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
  test('replace a number only where it is the whole argument', async () => {
    const { cases } = await recordUnit({ repoRoot, module: fixture('typed.ts'), tests: [fixture('typed.calls.ts')] });
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
});

describe('a guard', () => {
  const typed = fixture('typed.ts');
  const tests = [fixture('typed.calls.ts')];
  const record = (guards: GuardSpec[]) => recordUnit({ repoRoot, module: typed, tests, guards });
  const own = { fn: 'tagOf', argument: 0, guard: 'isTag' };

  test('keeps only the trap variants of its argument that the original accepts, and counts the rest as dropped', async () => {
    const plain = await record([]);
    const guarded = await record([own]);
    // Without the guard 39 variants change argument 0; `isTag` accepts 18.
    expect(trapsOf(plain.cases, 'tagOf', 0)).toHaveLength(39);
    const kept = trapsOf(guarded.cases, 'tagOf', 0);
    expect(kept).toHaveLength(18);
    for (const entry of kept) expect(isTag(entry.args[0])).toBe(true);
    // NaN and the infinities are numbers, which the guard rejects.
    expect(kept.filter((entry) => /:(nan|infinity|negative-infinity)@/.test(entry.origin))).toEqual([]);
    expect(guarded.manifest.guards).toEqual([{ ...own, dropped: 21, kept: 18 }]);
    expect(guarded.review[1]).toBe('  guard isTag on tagOf argument 0: dropped 21 of 39 trap variants');
    expect(plain.manifest.guards).toEqual([]);
    // A call the tests made stays, also one the guard rejects; so does every
    // variant of the other argument and of the other functions.
    expect(guarded.cases.filter((entry) => entry.origin === 'test').map((entry) => entry.args)).toEqual([['ab'], ['a tag longer than eight'], [3, 'none'], [{ first: 1, second: 2 }], [2]]);
    expect(withoutIds(trapsOf(guarded.cases, 'tagOf', 1))).toEqual(withoutIds(trapsOf(plain.cases, 'tagOf', 1)));
    expect(withoutIds(guarded.cases.filter((entry) => entry.fn !== 'tagOf'))).toEqual(withoutIds(plain.cases.filter((entry) => entry.fn !== 'tagOf')));
    const result = await replayCases(guarded.modulePath, guarded.cases, 'typed.ts');
    expect(result.cases.filter((entry) => entry.difference)).toEqual([]);
  });

  test('rejects a variant also when the guard throws for it', async () => {
    // `isShortTag` throws for a number.
    const guarded = await record([{ ...own, guard: 'isShortTag' }]);
    expect(guarded.manifest.guards).toEqual([{ ...own, guard: 'isShortTag', dropped: 21, kept: 18 }]);
    expect(trapsOf(guarded.cases, 'tagOf', 0).every((entry) => typeof entry.args[0] === 'string')).toBe(true);
  });

  test('can be an export of another file', async () => {
    const guard = `${fixture('guard.ts')}#isTagOfAtMostEight`;
    const guarded = await record([{ ...own, guard }]);
    expect(guarded.manifest.guards).toEqual([{ ...own, guard, dropped: 21, kept: 18 }]);
  });

  test('is asked before the original is called, and a rejected variant is no call', async () => {
    const guard = { argument: 0, spec: 'isTag' };
    expect(await evaluateInputs(resolve(repoRoot, typed), [
      { fn: 'tagOf', args: [3], guard },
      { fn: 'tagOf', args: ['ab'], guard },
      { fn: 'tagOf', args: [3] },
    ])).toEqual([{ guarded: true }, { result: '<ab>' }, { result: '-' }]);
  });

  test('must decide the same way in both runs of a variant', () => {
    const input: Input = { fn: 'tagOf', args: [3], kind: 'trap', origin: 'trap:zero@$.args[0]', guard: { argument: 0, spec: 'isTag' } };
    expect(mergeEvaluation(input, { guarded: true }, { guarded: true }, 500)).toEqual({ guarded: true, noise: [] });
    for (const [first, second] of [[{ guarded: true as const }, { result: '-' }], [{ result: '-' }, { guarded: true as const }]] as const) {
      expect(() => mergeEvaluation(input, first, second, 500))
        .toThrow('A guard of tagOf did not decide the same way in both runs: tagOf ([3]) [trap:zero@$.args[0]].');
    }
    // A guard that stalls in one run is listed like a call that stalls.
    expect(mergeEvaluation(input, { guarded: true }, { timedOut: true }, 500)).toEqual({
      noise: [],
      notCaptured: { fn: 'tagOf', where: 'result', path: '$.result', type: 'no outcome within 500 ms', at: null, count: 1 },
    });
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
  test('reports a result that differs from the recording, at its path', async () => {
    const directory = await temporary();
    await writeCases(directory, [
      { id: 'join#0', fn: 'join', args: [['a', 'b']], result: 'a;b', origin: 'test' },
      { id: 'join#1', fn: 'join', args: [['a', 'b']], result: 'a,b', origin: 'test' },
      { id: 'gone#0', fn: 'gone', args: [], result: null, origin: 'test' },
    ], { module: fixture('functions.ts'), tests: [], inputs: null, guards: [], notCaptured: [] });
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
    ], { module: fixture('functions.ts'), tests: [], inputs: null, guards: [], notCaptured: [] });
    await writeFile(join(directory, 'cases.jsonl'), (await Bun.file(join(directory, 'cases.jsonl')).text()).replace('a,b', 'a;b'));
    await expect(replayUnit(repoRoot, directory)).rejects.toThrow('is not the recorded file');
  });
});
