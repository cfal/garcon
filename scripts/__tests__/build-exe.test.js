import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { compileOptionsForTarget, EMBEDDED_WORKER_SOURCES } from '../build-exe.js';
import { GARCON_WORKER_NAMES } from '../../server-agents/common/src/build/standalone-entrypoint.js';

test('every worker has a real standalone bundle source, including display preparation and reads', async () => {
  expect(Object.keys(EMBEDDED_WORKER_SOURCES).sort()).toEqual([...GARCON_WORKER_NAMES].sort());
  for (const source of Object.values(EMBEDDED_WORKER_SOURCES)) {
    expect(await Bun.file(path.resolve(import.meta.dir, '../..', source)).exists()).toBe(true);
  }
});

describe('compileOptionsForTarget', () => {
  test('uses Bun target resolution when no executable is configured', () => {
    expect(compileOptionsForTarget('linux-x64', 'dist/garcon', {})).toEqual({
      target: 'bun-linux-x64-baseline',
      outfile: 'dist/garcon',
    });
  });

  test('uses the configured executable for the requested target', () => {
    expect(compileOptionsForTarget('linux-x64', 'dist/garcon', {
      GARCON_BUN_COMPILE_LINUX_X64_EXECUTABLE: ' ./targets/bun ',
      GARCON_BUN_COMPILE_WINDOWS_X64_EXECUTABLE: './targets/bun.exe',
    })).toEqual({
      target: 'bun-linux-x64-baseline',
      outfile: 'dist/garcon',
      executablePath: path.resolve('./targets/bun'),
    });
  });
});
