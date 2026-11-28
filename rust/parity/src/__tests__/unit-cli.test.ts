import { describe, expect, test } from 'bun:test';
import { parseRecord } from '../unit/cli.js';

const record = (...rest: string[]) => ['common/a.ts', '--out', 'cases/a', ...rest];

describe('parseRecord', () => {
  test('reads the module, its tests, an inputs file, and the output directory', () => {
    expect(parseRecord(record('--tests', 'common/__tests__/a.test.js', '--inputs', 'a.jsonl', '--out', 'elsewhere'))).toEqual({
      module: 'common/a.ts',
      tests: ['common/__tests__/a.test.js'],
      inputs: 'a.jsonl',
      guards: [],
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
      out: 'cases/a',
    });
    // Tests may follow a guard.
    expect(parseRecord(record('--tests', 'a.js', '--guard', 'f:0=g', '--tests', 'b.js')).tests).toEqual(['a.js', 'b.js']);
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
