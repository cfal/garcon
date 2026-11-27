import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
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
    expect(await (await fetch(`${server.baseUrl}/api/v1/auth/status`)).json())
      .toEqual({ needsSetup: false, isAuthenticated: false, authDisabled: false });
    const stored = JSON.parse(await readFile(join(server.dirs.configDir, 'auth.json'), 'utf8')) as { username?: string };
    expect(stored.username).toBe('parity');
  });

  test('seeds files under config/ and workspace/ with the modes the original gives its own', async () => {
    const server = await start({
      account: 'none',
      files: {
        'workspace/executors.json': '{"version":1,"executors":[]}',
        'workspace/nested/deep/state.json': '{}',
        'config/extra.json': '{}',
      },
    });
    const mode = async (path: string) => (await stat(path)).mode & 0o777;
    // The original refuses to start while a credential file is readable by another account.
    expect(await mode(join(server.dirs.workspaceDir, 'executors.json'))).toBe(0o600);
    expect(await mode(join(server.dirs.configDir, 'extra.json'))).toBe(0o600);
    expect(await mode(server.dirs.workspaceDir)).toBe(0o700);
    expect(await mode(server.dirs.configDir)).toBe(0o700);
    expect(await mode(join(server.dirs.workspaceDir, 'nested'))).toBe(0o700);
    expect(await mode(join(server.dirs.workspaceDir, 'nested/deep'))).toBe(0o700);
    expect(await mode(join(server.dirs.workspaceDir, 'nested/deep/state.json'))).toBe(0o600);
  });

  test('starts without an account when a scenario asks for none', async () => {
    const server = await start({ account: 'none' });
    expect(server.token).toBe('');
    expect(server.credentials).toEqual({ username: 'parity', password: '' });
    await expect(readFile(join(server.dirs.configDir, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('starts with authentication disabled when a scenario asks for it, and takes no token', async () => {
    const server = await start({ account: 'none', auth: 'disabled' });
    // The sign-in route refuses while authentication is disabled, so there is no token to take.
    expect(server.token).toBe('');
    expect(await (await fetch(`${server.baseUrl}/api/v1/auth/status`)).json())
      .toEqual({ needsSetup: false, isAuthenticated: true, authDisabled: true });
    const login = await fetch(`${server.baseUrl}/api/v1/auth/login`, { method: 'POST' });
    expect(login.status).toBe(403);
    expect(await login.json()).toMatchObject({ errorCode: 'AUTH_CHANGE_FORBIDDEN' });
    // A scenario that asks for an account still gets one.
    const provisioned = await start({ auth: 'disabled' });
    expect(provisioned.token).toBe('');
    expect(provisioned.credentials.password).not.toBe('');
    expect(JSON.parse(await readFile(join(provisioned.dirs.configDir, 'auth.json'), 'utf8'))).toMatchObject({ username: 'parity' });
  });
});
