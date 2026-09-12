import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runSystemdHelper, SYSTEMD_HELPER_BUN_OPTIONS, systemdHelperCommand } from '../systemd/helper-process.js';
import { launch } from './systemd-fixture.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-helper-launch-'));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test.each(['missing', 'relative', 'absent', 'symlink', 'public', 'populated'])('default helper refuses %s cwd before spawning', async (kind) => {
  const root = await fixture();
  let directory: string | undefined = root;
  if (kind === 'missing') directory = undefined;
  else if (kind === 'relative') directory = '.';
  else if (kind === 'absent') directory = path.join(root, 'absent');
  else if (kind === 'symlink') { directory = path.join(root, 'link'); await symlink(root, directory); }
  else if (kind === 'public') await chmod(root, 0o755);
  else await writeFile(path.join(root, '.env'), 'SYNTHETIC=retained');
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('Unexpected synthetic spawn'); });
  try {
    await expect(runSystemdHelper({ kind: 'inspect', launch }, { workingDirectory: directory }))
      .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_UNAVAILABLE' });
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
});

test('default helper pins source options, environment and cwd before a sanitized spawn failure', async () => {
  const root = await fixture();
  const directory = path.join(root, 'empty'); await mkdir(directory, { mode: 0o700 });
  const previous = process.env.BUN_OPTIONS;
  process.env.BUN_OPTIONS = '--preload=synthetic-hostile';
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('synthetic private executable path'); });
  try {
    await expect(runSystemdHelper({ kind: 'inspect', launch }, { workingDirectory: directory }))
      .rejects.toMatchObject({ code: 'NODE_CONTAINMENT_UNAVAILABLE' });
    expect(systemdHelperCommand().slice(1, 3)).toEqual(['--no-env-file', '--config=/dev/null']);
    expect(spawn).toHaveBeenCalledWith(systemdHelperCommand(), {
      cwd: directory, stdin: new TextEncoder().encode(JSON.stringify({ kind: 'inspect', launch })), stdout: 'pipe', stderr: 'ignore',
      env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        BUN_OPTIONS: SYSTEMD_HELPER_BUN_OPTIONS },
    });
  } finally {
    spawn.mockRestore();
    if (previous === undefined) delete process.env.BUN_OPTIONS; else process.env.BUN_OPTIONS = previous;
  }
});

test('compiled helper argv retains the application dispatch shape', () => {
  const symbol = Symbol.for('garcon.compiled-mode');
  const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
  Object.defineProperty(globalThis, symbol, { value: true, configurable: true });
  try { expect(systemdHelperCommand()).toEqual([process.execPath, '--internal-systemd-helper']); }
  finally { if (previous) Object.defineProperty(globalThis, symbol, previous); else Reflect.deleteProperty(globalThis, symbol); }
});
