import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSystemdHelper, systemdHelperCommand } from '../../../server/execution-node/systemd/helper-process.js';

describe.skipIf(process.platform !== 'linux')('execution-node native helper isolation', () => {
  test('kills and reaps a helper blocked in real D-Bus authentication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-systemd-helper-'));
    const authenticated = Promise.withResolvers<void>();
    const socketPath = join(root, 'bus');
    const listener = Bun.listen({ unix: socketPath, socket: {
      data(_socket, bytes) {
        if (bytes.includes(Buffer.from('AUTH EXTERNAL'))) authenticated.resolve();
      },
    } });
    let child: Bun.Subprocess<Uint8Array, 'pipe', 'ignore'> | undefined;
    let expire: (() => void) | undefined;
    let cancelled = false;
    let settled = false;
    const watchdog = setTimeout(() => {
      child?.kill('SIGKILL');
      authenticated.reject(new Error('Helper never reached D-Bus authentication'));
    }, 3_000);
    try {
      const result = runSystemdHelper({ kind: 'inspect', launch: {
        unitName: `garcon-exec-${'a'.repeat(64)}.service`, launchId: 'b'.repeat(32),
      } }, {
        spawn(request) {
          const processHandle = Bun.spawn(systemdHelperCommand(), {
            stdin: new TextEncoder().encode(request), stdout: 'pipe', stderr: 'ignore',
            env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${socketPath}`,
              GARCON_CONFIG_DIR: join(root, 'controller-config'), GARCON_PORT: 'invalid' },
          });
          child = processHandle;
          return { output: processHandle.stdout, exited: processHandle.exited, kill: () => processHandle.kill('SIGKILL') };
        },
        scheduleTimeout(callback) { expire = callback; return { cancel() { cancelled = true; } }; },
      }).catch((error: unknown) => { settled = true; return error; });
      await authenticated.promise;
      expect(child?.exitCode).toBeNull();
      expect(settled).toBe(false);
      expire!();
      expect(await result).toMatchObject({ code: 'NODE_CLEANUP_TIMEOUT' });
      expect(await child?.exited).not.toBe(0);
      expect(child?.signalCode).toBe('SIGKILL');
      expect(cancelled).toBe(true);
      expect(await readdir(root)).toEqual(['bus']);
    } finally {
      clearTimeout(watchdog);
      listener.stop(true);
      if (child && child.exitCode === null) child.kill('SIGKILL');
      if (child) await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }, 5_000);
});
