import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GarconProcess } from '../../support/garcon-process.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function createDirectories() {
  const root = await mkdtemp(join(tmpdir(), 'garcon-auth-corrupt-state-'));
  const directories = {
    root,
    config: join(root, 'config'),
    workspace: join(root, 'workspace'),
    project: join(root, 'project'),
    home: join(root, 'home'),
  };
  await Promise.all(Object.values(directories).map((directory) =>
    mkdir(directory, { recursive: true })));
  return directories;
}

function processOptions(directories: Awaited<ReturnType<typeof createDirectories>>) {
  return {
    repoRoot: REPO_ROOT,
    configDir: directories.config,
    workspaceDir: directories.workspace,
    projectDir: directories.project,
    homeDir: directories.home,
    disableAuth: false,
  };
}

describe('corrupt auth state', () => {
  test('quarantines corrupt auth state and refuses startup', async () => {
    const directories = await createDirectories();
    const authPath = join(directories.config, 'auth.json');
    const corruptBytes = '{"jwtSecret":"startup-secret"';
    let garcon: GarconProcess | null = null;
    try {
      await writeFile(authPath, corruptBytes, { mode: 0o600 });
      let startError: unknown;
      try {
        garcon = await GarconProcess.start(processOptions(directories));
      } catch (error) {
        startError = error;
      }

      expect(startError).toBeInstanceOf(Error);
      expect((startError as Error).message).toContain('Garcon exited unexpectedly with code 1');
      const [quarantineName] = (await readdir(directories.config)).filter((entry) =>
        entry.startsWith('auth.json.corrupt-'));
      expect(await readFile(join(directories.config, quarantineName), 'utf8')).toBe(corruptBytes);
      await expect(readFile(authPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await garcon?.stop();
      await rm(directories.root, { recursive: true, force: true });
    }
  });

  test('keeps registration closed after runtime auth corruption', async () => {
    const directories = await createDirectories();
    const authPath = join(directories.config, 'auth.json');
    const corruptBytes = '{"jwtSecret":"runtime-secret"';
    let garcon: GarconProcess | null = null;
    try {
      garcon = await GarconProcess.start(processOptions(directories));
      await writeFile(authPath, corruptBytes, { mode: 0o600 });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${garcon.baseUrl}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'attacker', password: 'password123' }),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'Internal server error' });
      }

      const [quarantineName] = (await readdir(directories.config)).filter((entry) =>
        entry.startsWith('auth.json.corrupt-'));
      expect(await readFile(join(directories.config, quarantineName), 'utf8')).toBe(corruptBytes);
      await expect(readFile(authPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await garcon?.stop();
      await rm(directories.root, { recursive: true, force: true });
    }
  });
});
