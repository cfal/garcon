import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseTestArguments, selectTestFiles } from '../run-test-files.js';

const runner = resolve(import.meta.dir, '../run-test-files.js');
const directories = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsharded selection preserves every file in deterministic order', () => {
  const files = ['c.test.ts', 'a.test.ts', 'b.test.ts'];
  expect(selectTestFiles(files)).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
  expect(files).toEqual(['c.test.ts', 'a.test.ts', 'b.test.ts']);
  expect(parseTestArguments(['--max-concurrency=1', '--timeout=120000'])).toEqual({
    shard: undefined,
    testArgs: ['--max-concurrency=1', '--timeout=120000'],
  });
});

test.each([1, 2, 3, 4])('%i shards cover each file exactly once', (total) => {
  const files = ['f.test.ts', 'a.test.ts', 'e.test.ts', 'c.test.ts', 'b.test.ts', 'd.test.ts', 'g.test.ts'];
  const sorted = [...files].sort();
  const shards = Array.from({ length: total }, (_, offset) => {
    const { shard, testArgs } = parseTestArguments(['--max-concurrency=1', `--shard=${offset + 1}/${total}`, '--timeout=120000']);
    expect(testArgs).toEqual(['--max-concurrency=1', '--timeout=120000']);
    const selected = selectTestFiles(files, shard);
    expect(selected).toEqual(sorted.filter((_, index) => index % total === offset));
    return selected;
  });
  expect(shards.flat().sort()).toEqual(sorted);
  expect(new Set(shards.flat()).size).toBe(files.length);
});

test.each(['--shard', '--shard=', '--shard=0/2', '--shard=3/2', '--shard=1/0', '--shard=-1/2', '--shard=1.5/2', '--shard=1/two', '--shard=1/2/3', '--shard=1/9007199254740992'])(
  'rejects malformed selection %s', (argument) => {
    expect(() => parseTestArguments([argument])).toThrow();
  },
);

test('rejects duplicate shard arguments and empty selections', () => {
  expect(() => parseTestArguments(['--shard=1/2', '--shard=2/2'])).toThrow('Only one');
  expect(() => selectTestFiles([])).toThrow('No test files selected');
  expect(() => selectTestFiles(['a.test.ts'], { index: 2, total: 2 })).toThrow('No test files selected');
});

async function fixture(files) {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-test-runner-'));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  return directory;
}

async function run(directory, args = []) {
  const child = Bun.spawn([process.execPath, runner, '*.test.js', ...args], {
    cwd: directory,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return { exitCode: await child.exited, stdout: await stdout, stderr: await stderr };
}

test('CLI partitions files before spawning isolated Bun processes', async () => {
  const source = `import { test } from 'bun:test';
    test('synthetic runner fixture', () => {
      console.log('RUNNER_RECORD ' + JSON.stringify({ file: import.meta.file, pid: process.pid }));
    });`;
  const directory = await fixture(Object.fromEntries(['d', 'c', 'b', 'a'].map(name => [`${name}.test.js`, source])));
  const result = await run(directory, ['--shard=1/2', '--max-concurrency=1', '--timeout=120000']);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain('Test shard 1/2: 2 of 4 files');
  const records = result.stdout.split('\n').filter(line => line.startsWith('RUNNER_RECORD '))
    .map(line => JSON.parse(line.slice('RUNNER_RECORD '.length)));
  expect(records.map(record => record.file)).toEqual(['a.test.js', 'c.test.js']);
  expect(new Set(records.map(record => record.pid)).size).toBe(2);
});

test('CLI preserves child failures and does not run later files', async () => {
  const directory = await fixture({
    'a.test.js': 'process.exit(7);',
    'b.test.js': 'console.log("UNEXPECTED_LATER_FILE");',
  });
  const result = await run(directory);
  expect(result.exitCode).toBe(7);
  expect(result.stdout).not.toContain('UNEXPECTED_LATER_FILE');
});

test('CLI fails on an empty glob instead of reporting success', async () => {
  const result = await run(await fixture({}));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('No test files selected');
});
