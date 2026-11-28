import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pinnedBunVersion } from '../bun-version.js';
import { parseRecord, unitCli } from '../unit/cli.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const fixture = (name: string) => `rust/parity/src/__tests__/fixtures/unit/${name}`;
const record = (...rest: string[]) => ['common/a.ts', '--out', 'cases/a', ...rest];

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-unit-cli-'));
  directories.push(directory);
  return directory;
}

describe('parseRecord', () => {
  test('reads the module, its tests, an inputs file, and the output directory', () => {
    expect(parseRecord(record('--tests', 'common/__tests__/a.test.js', '--inputs', 'a.jsonl', '--out', 'elsewhere'))).toEqual({
      module: 'common/a.ts',
      tests: ['common/__tests__/a.test.js'],
      inputs: 'a.jsonl',
      guards: [],
      jsonArguments: [],
      out: 'elsewhere',
    });
  });

  test('reads each guard as a function, an argument, and the original function that guards it', () => {
    expect(parseRecord(record(
      '--tests', 't.js',
      '--guard', 'parseA:0=isA',
      '--guard', 'Ticket.parse:1=common/tags.ts#isTag',
      '--guard', 'new Ticket:0=isTag',
    ))).toEqual({
      module: 'common/a.ts',
      tests: ['t.js'],
      guards: [
        { fn: 'parseA', argument: 0, guard: 'isA' },
        { fn: 'Ticket.parse', argument: 1, guard: 'common/tags.ts#isTag' },
        { fn: 'new Ticket', argument: 0, guard: 'isTag' },
      ],
      jsonArguments: [],
      out: 'cases/a',
    });
    // Tests may follow a guard.
    expect(parseRecord(record('--tests', 'a.js', '--guard', 'f:0=g', '--tests', 'b.js')).tests).toEqual(['a.js', 'b.js']);
  });

  test('reads each JSON declaration as a function and an argument', () => {
    expect(parseRecord(record('--tests', 't.js', '--json', 'parseA:0', '--json', 'Ticket.parse:2')).jsonArguments).toEqual([
      { fn: 'parseA', argument: 0 },
      { fn: 'Ticket.parse', argument: 2 },
    ]);
    for (const declared of ['f', 'f:x', 'f:0=g', ':0']) {
      expect(() => parseRecord(record('--tests', 't.js', '--json', declared)))
        .toThrow(`A function and an argument are <function>:<argument index>; got "${declared}".`);
    }
    expect(() => parseRecord(record('--tests', 't.js', '--json'))).toThrow('--json needs a value.');
  });

  test('refuses a guard that is not <function>:<argument index>=<guard>', () => {
    for (const guard of ['f', 'f:0', 'f:0=', 'f:x=g', ':0=g', 'f:0=#g', 'f:0=g.ts#', 'f:0=g.ts#isTag#more']) {
      expect(() => parseRecord(record('--tests', 't.js', '--guard', guard))).toThrow(
        `A guard is <function>:<argument index>=<guard>, where <guard> is an export of the recorded module or <file>#<export>; got "${guard}".`,
      );
    }
  });

  test('refuses an option without its value, an unknown option, and a missing output directory', () => {
    expect(() => parseRecord(record('--tests', 't.js', '--guard'))).toThrow('--guard needs a value.');
    expect(() => parseRecord(record('--tests', 't.js', '--out'))).toThrow('--out needs a value.');
    expect(() => parseRecord(['common/a.ts', '--tests', 't.js'])).toThrow('record needs --out <dir>.');
    expect(() => parseRecord(record('--tests', 't.js', '--guards', 'f:0=g'))).toThrow('Unknown option: --guards');
    expect(() => parseRecord(['common/a.ts', 'other.js', '--tests', 't.js', '--out', 'o'])).toThrow('Unexpected argument: other.js');
    expect(() => parseRecord(['--tests', 't.js'])).toThrow('record takes the module path first.');
    expect(() => parseRecord(record())).toThrow('record needs --tests or --inputs.');
  });
});

describe('unitCli', () => {
  test('refuses to record on another Bun than the pinned one unless --any-bun is given, and only warns for a replay', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const directory = join(await temporary(), 'typed');
      const recordArgs = ['record', fixture('typed.ts'), '--tests', fixture('typed.calls.ts'), '--out', directory];
      // On the pinned Bun the flag changes nothing, and wherever it stands it is not an argument.
      expect(await unitCli(['record', '--any-bun', ...recordArgs.slice(1)], repoRoot)).toBe(0);
      const pinned = await pinnedBunVersion(repoRoot);
      expect(await unitCli(recordArgs, repoRoot)).toBe(Bun.version === pinned ? 0 : 2);
      // A replay goes ahead on any Bun, with a warning.
      expect(await unitCli(['replay', directory], repoRoot)).toBe(0);
      const printed = error.mock.calls.map((call) => String(call[0]));
      if (Bun.version !== pinned) {
        expect(printed.some((text) => text.includes(`Start it with Bun ${pinned}, or pass --any-bun to record anyway.`))).toBe(true);
      }
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test('prints the usage for what it does not understand', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await unitCli(['records', 'x'], repoRoot)).toBe(2);
      expect(await unitCli([], repoRoot)).toBe(2);
    } finally {
      log.mockRestore();
    }
  });
});
