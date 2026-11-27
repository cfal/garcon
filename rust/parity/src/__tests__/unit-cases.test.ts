import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES_FILE, MANIFEST_FILE, MAX_CASE_BYTES, mergeCaptured, readCases, writeCases, type CaptureRecord } from '../unit/cases.js';
import type { Json } from '../wildcard.js';

const call = (seq: number, fn: string, args: Json[], result: Json): CaptureRecord => ({ seq, fn, args, result });
const uncaptured = (seq: number, fn: string, where: 'args' | 'result', path: string, type: string, at: string | null = null): CaptureRecord =>
  ({ seq, fn, notCaptured: { where, path, type, at } });
const shown = (merged: ReturnType<typeof mergeCaptured>) => merged.cases.map((entry) => [entry.fn, entry.args, entry.result]);

const directories: string[] = [];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-unit-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('mergeCaptured', () => {
  test('keeps one case per distinct call in the original key order', () => {
    const run = [
      call(0, 'parse', ['b'], { b: 1, a: [2, { d: true, c: null }] }),
      call(1, 'parse', ['a'], null),
      call(2, 'parse', ['b'], { b: 1, a: [2, { d: true, c: null }] }),
    ];
    const merged = mergeCaptured(run, run);
    expect(shown(merged)).toEqual([
      ['parse', ['b'], { b: 1, a: [2, { d: true, c: null }] }],
      ['parse', ['a'], null],
    ]);
    expect(merged.noise).toEqual([]);
    expect(merged.notCaptured).toEqual([]);
  });

  test('turns a result that differs between the runs into a wildcard and reports it', () => {
    const merged = mergeCaptured(
      [call(0, 'create', ['x'], { id: 'chat-111', title: 'Chat 111', at: '2026-11-27T10:00:00.000Z' })],
      [call(0, 'create', ['x'], { id: 'chat-222', title: 'Chat 111', at: '2026-11-27T10:05:00.000Z' })],
    );
    // Both runs vary the same way, so each wildcard keeps that shape.
    expect(shown(merged)).toEqual([['create', ['x'], { id: 'chat-[..digits:3]', title: 'Chat 111', at: '2026-11-27T10:[..digits:2]:00.000Z' }]]);
    expect(merged.noise).toEqual(['create(["x"]): differs between runs at $.result.at, $.result.id']);
  });

  test('wildcards a call captured in one run only and reports it', () => {
    const merged = mergeCaptured([call(0, 'f', [1], 1), call(1, 'f', [2], 2)], [call(0, 'f', [1], 1), call(1, 'g', [], 9)]);
    expect(shown(merged)).toEqual([['f', [1], 1], ['f', [2], '[..]'], ['g', [], '[..]']]);
    expect(merged.noise).toEqual(['f([2]): captured in the first run only; its result is a wildcard', 'g([]): captured in the second run only; its result is a wildcard']);
  });

  test('keeps each distinct result of a call and reports the difference within a run', () => {
    const run = [call(0, 'next', [], 1), call(1, 'next', [], 2), call(2, 'next', [], 2)];
    const merged = mergeCaptured(run, run);
    expect(shown(merged)).toEqual([['next', [], 1], ['next', [], 2]]);
    expect(merged.noise).toEqual([
      'next([]): different results for the same arguments within the first run',
      'next([]): different results for the same arguments within the second run',
    ]);
  });

  test('lists calls that could not be encoded with where the test made them', () => {
    const merged = mergeCaptured(
      [uncaptured(0, 'wrap', 'result', '$.result', 'a Thing instance', 'common/__tests__/x.test.js:12:9'), uncaptured(1, 'wrap', 'result', '$.result', 'a Thing instance', 'common/__tests__/x.test.js:12:9'), uncaptured(2, 'save', 'args', '$.args[0].stream', 'a function', 'common/__tests__/x.test.js:20:5')],
      [uncaptured(0, 'wrap', 'result', '$.result', 'a Thing instance', 'common/__tests__/x.test.js:12:9'), uncaptured(1, 'save', 'args', '$.args[0].stream', 'a function', 'common/__tests__/x.test.js:20:5')],
    );
    expect(merged.cases).toEqual([]);
    expect(merged.notCaptured).toEqual([
      { fn: 'wrap', where: 'result', path: '$.result', type: 'a Thing instance', at: 'common/__tests__/x.test.js:12:9', count: 2 },
      { fn: 'save', where: 'args', path: '$.args[0].stream', type: 'a function', at: 'common/__tests__/x.test.js:20:5', count: 1 },
    ]);
  });

  test('lists a call whose encoding is too large to record', () => {
    const merged = mergeCaptured([call(0, 'read', ['x'.repeat(MAX_CASE_BYTES)], 'ok')], [call(0, 'read', ['x'.repeat(MAX_CASE_BYTES)], 'ok')]);
    expect(merged.cases).toEqual([]);
    expect(merged.notCaptured).toEqual([{ fn: 'read', where: 'args', path: '$.args', type: `more than ${MAX_CASE_BYTES} bytes encoded`, at: null, count: 1 }]);
  });
});

describe('recordings on disk', () => {
  const cases = [
    { id: 'parse#0', fn: 'parse', args: [''] as Json[], result: '' as Json, origin: 'test' },
    { id: 'parse#1', fn: 'parse', args: ['/x'] as Json[], result: { $: 'error', name: 'Error', message: 'bad', properties: {} } as Json, origin: 'trap:empty@$.args[0]' },
  ];
  const manifest = { module: 'common/parse.ts', tests: ['common/__tests__/parse.test.js'], inputs: null, notCaptured: [] };

  test('are one JSON line per case and a manifest with the digest of the case file', async () => {
    const directory = await temporary();
    const written = await writeCases(directory, cases, manifest);
    expect(written.cases).toBe(2);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    const text = await Bun.file(join(directory, CASES_FILE)).text();
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);
    expect(JSON.parse(text.split('\n')[0]!)).toEqual({ id: 'parse#0', fn: 'parse', args: [''], result: '', origin: 'test' });
    expect(await readCases(directory)).toEqual({ manifest: written, cases });
  });

  test('fail to read when the case file was edited', async () => {
    const directory = await temporary();
    await writeCases(directory, cases, manifest);
    const path = join(directory, CASES_FILE);
    const text = await Bun.file(path).text();
    for (const edit of [
      text.replace('"result":""', '"result":"x"'),
      `${text}{"id":"parse#2","fn":"parse","args":["/y"],"result":"/y","origin":"test"}\n`,
      text.trimEnd(),
    ]) {
      await writeFile(path, edit);
      await expect(readCases(directory)).rejects.toThrow(/is not the recorded file \(sha256 [0-9a-f]{12}, manifest [0-9a-f]{12}\)/);
    }
  });

  test('fail to read when the manifest does not count the cases', async () => {
    const directory = await temporary();
    await writeCases(directory, cases, { ...manifest, module: 'elsewhere.ts' });
    const path = join(directory, MANIFEST_FILE);
    await writeFile(path, (await Bun.file(path).text()).replace('"cases": 2', '"cases": 3'));
    await expect(readCases(directory)).rejects.toThrow('2 cases, manifest 3');
  });

  test('name a recording that was never made', async () => {
    const directory = await temporary();
    await expect(readCases(directory)).rejects.toThrow(`/${CASES_FILE} not found; run \`bun rust/parity/cli.ts unit record\`.`);
  });
});
