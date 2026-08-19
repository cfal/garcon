import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { compileOptionsForTarget } from '../build-exe.js';

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
