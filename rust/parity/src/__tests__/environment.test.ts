import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { startServer, type ServerBuild, type StartedServer } from '../environment.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
// The stand-in controller ignores the controller's arguments and answers a few routes.
const probe: ServerBuild = { label: 'probe', command: [process.execPath, resolve(import.meta.dir, 'fixtures/probe-server.ts')] };

const started: StartedServer[] = [];
async function start(options: Parameters<typeof startServer>[2] = {}): Promise<StartedServer> {
  const server = await startServer(repoRoot, probe, options);
  started.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.stop()));
});

describe('startServer', () => {
  test('gives the server a fixed PATH, whatever PATH the harness itself has', async () => {
    const harnessPath = process.env.PATH;
    process.env.PATH = '/agent-clis-on-this-machine:/usr/bin:/bin';
    try {
      const server = await start({ account: 'none' });
      const response = await fetch(`${server.baseUrl}/api/v1/path`);
      // No agent CLI installed on the machine is on it, so catalogs do not depend on the machine.
      expect(await response.text()).toBe('/usr/bin:/bin');
    } finally {
      if (harnessPath === undefined) delete process.env.PATH;
      else process.env.PATH = harnessPath;
    }
  });

  test('provisions an account and takes a session token by default', async () => {
    const server = await start();
    expect(server.token).toBe('probe-session-token');
    const stored = JSON.parse(await readFile(join(server.dirs.configDir, 'auth.json'), 'utf8')) as { username?: string };
    expect(stored.username).toBe('parity');
  });

  test('starts without an account when a scenario asks for none', async () => {
    const server = await start({ account: 'none' });
    expect(server.token).toBe('');
    expect(server.credentials).toEqual({ username: 'parity', password: '' });
    await expect(readFile(join(server.dirs.configDir, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
