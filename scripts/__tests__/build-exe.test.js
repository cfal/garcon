import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { compileOptionsForTarget, createVirtualMainEntrypoint } from '../build-exe.js';
import { SYSTEMD_HELPER_FLAG } from '../../server/execution-node/systemd/contracts.js';
import { systemdHelperCommand } from '../../server/execution-node/systemd/helper-process.js';
import { smokeSystemdHelper } from '../smoke-systemd-helper.js';

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

describe('compiled entrypoint roles', () => {
  test('private helper smoke rejects a binary that unconditionally reports success', async () => {
    const command = [process.execPath, '-e', "console.log(JSON.stringify({ kind: 'stopped' }));"];
    await expect(smokeSystemdHelper(command, {
      probeManager: () => '/synthetic/user-manager',
    })).rejects.toThrow('did not reach containment validation');
  });
  test('private helper smoke rejects a binary whose native path always fails', async () => {
    const command = [process.execPath, '-e',
      "console.log(JSON.stringify({ kind: 'failed', code: 'NODE_CONTAINMENT_UNAVAILABLE' }));"];
    await expect(smokeSystemdHelper(command, {
      probeManager: () => '/synthetic/user-manager',
    })).rejects.toMatchObject({ code: 'NODE_CONTAINMENT_UNAVAILABLE' });
  });
  test('private source dispatch reaches containment without controller or provider storage', async () => {
    await smokeSystemdHelper(systemdHelperCommand());
  });
  test.each([true, false])('private helper skips provider setup (helper: %p)', async (helper) => {
    const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const entry = createVirtualMainEntrypoint(
      moduleUrl('export {};'),
      moduleUrl(`console.log(JSON.stringify({ compiled: globalThis[Symbol.for('garcon.compiled-mode')], prepared: globalThis.prepared === true }));`),
      [moduleUrl('globalThis.prepared = true;')],
      { entries: ['indexer', 'reader'].map((name) => ({ name, filePath: path.resolve(`synthetic-${name}.js`) })) },
    );
    const child = Bun.spawn([process.execPath, '-e', entry, '--', ...(helper ? [SYSTEMD_HELPER_FLAG] : [])], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      const [output, diagnostic, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, diagnostic).toBe(0);
      expect(JSON.parse(output)).toEqual({ compiled: true, prepared: !helper });
    } finally { clearTimeout(timer); }
  });
});
