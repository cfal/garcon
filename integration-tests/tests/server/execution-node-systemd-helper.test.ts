import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { systemdHelperCommand } from '../../../server/execution-node/systemd/helper-process.js';

const executable = process.env.GARCON_TEST_HELPER_EXECUTABLE;

async function probe(mode: 'watchdog' | 'orphan' | 'stdin' | 'ffi', ignored = true, blocked = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'garcon-helper-'));
  const cwd = path.join(root, 'empty');
  for (const name of ['empty', 'hostile', 'hostile-home', 'runtime']) await mkdir(path.join(root, name), { mode: 0o700 });
  const preload = path.join(root, 'hostile/preload.ts');
  await writeFile(preload, `await Bun.write(${JSON.stringify(path.join(root, 'preload-ran'))}, 'synthetic'); console.log(JSON.stringify({kind:'ready',identity:{unitName:'garcon-exec-${'a'.repeat(64)}.service',launchId:'${'b'.repeat(32)}',invocationId:'${'c'.repeat(32)}',mainPid:1234,controlGroup:'/synthetic'}})); process.exit(0);`);
  for (const directory of ['hostile', 'hostile-home']) {
    await writeFile(path.join(root, directory, '.env'), `DBUS_SESSION_BUS_ADDRESS=unix:path=${path.join(root, 'forbidden-bus')}\n`);
    await writeFile(path.join(root, directory, directory === 'hostile' ? 'bunfig.toml' : '.bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
  }
  const command = mode === 'ffi'
    ? [process.execPath, '--no-env-file', '--config=/dev/null', path.join(import.meta.dir, '../../support/systemd-helper-blocked.ts')]
    : executable ? [executable, '--internal-systemd-helper'] : systemdHelperCommand();
  const request = { root, mode, ignored, blocked, cwd, command, executable, bun: process.execPath,
    parent: path.join(import.meta.dir, '../../support/systemd-helper-parent.ts') };
  const child = Bun.spawn(['python3', path.join(import.meta.dir, '../../support/systemd-helper-lifetime.py'), JSON.stringify(request)], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  try {
    const [code, output, diagnostic] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, diagnostic).toBe(0);
    expect(await readdir(cwd)).toEqual([]);
    expect((await readdir(root)).includes('preload-ran')).toBe(false);
    const result = JSON.parse(output) as { rescued: boolean; helperSignal?: string; noBootstrap?: boolean; authenticated?: boolean;
      adoptedAndReaped?: boolean; parentDeadline?: boolean; socketClosed?: boolean; cwdContents?: string[]; elapsedMs: number };
    expect(result.rescued).toBe(false);
    return result;
  } finally {
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))('execution-node native helper isolation', () => {
  test('failed authentication setup rescues and reaps an unidentified adopted helper while failing the harness', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'garcon-helper-no-connect-'));
    const child = Bun.spawn(['python3', path.join(import.meta.dir, '../../support/systemd-helper-lifetime.py'), JSON.stringify({
      root, mode: 'no-connect', bun: process.execPath,
      parent: path.join(import.meta.dir, '../../support/systemd-helper-parent.ts'),
    })], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    try {
      const [code, output, diagnostic] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      expect(output).toBe('');
      expect(diagnostic).toContain('TimeoutError: timed out');
      const announcement = await Bun.file(path.join(root, 'unconnected-helper.json')).json() as { pid: number; startTicks: string };
      const cleanup = diagnostic.split('\n').find((line) => line.startsWith('{"rescuedChildren":'));
      expect(cleanup).toBeDefined();
      expect(JSON.parse(cleanup!).rescuedChildren).toEqual([{ ...announcement, killed: true, reaped: true }]);
      expect(await Bun.file(`/proc/${announcement.pid}/stat`).exists()).toBe(false);
    } finally {
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('default launcher rejects ambient autoload and the parent deadline reaps blocked authentication', async () => {
    const result = await probe('watchdog');
    expect(result.authenticated).toBe(true);
    expect(result.parentDeadline).toBe(true);
    expect(result.socketClosed).toBe(true);
    expect(result.cwdContents).toEqual([]);
  }, 30_000);

  test('default-launcher helper exits and is reaped after parent SIGKILL during real authentication', async () => {
    const result = await probe('orphan');
    expect(result.authenticated).toBe(true);
    expect(result.adoptedAndReaped).toBe(true);
    expect(result.helperSignal).toBe('SIGALRM');
    expect(result.socketClosed).toBe(true);
    expect(result.cwdContents).toEqual([]);
  }, 30_000);

  test('helper self-deadline precedes open stdin without EOF or bus bootstrap', async () => {
    const result = await probe('stdin');
    expect(result.helperSignal).toBe('SIGALRM');
    expect(result.noBootstrap).toBe(true);
  }, 30_000);

  test.each([[false, false], [true, false], [false, true], [true, true]])('kernel deadline interrupts blocked FFI with inherited ignore=%s block=%s', async (ignored, blocked) => {
    const result = await probe('ffi', ignored, blocked);
    expect(result.helperSignal).toBe('SIGALRM');
  }, 10_000);
});
