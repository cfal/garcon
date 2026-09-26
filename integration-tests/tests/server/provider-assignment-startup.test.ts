import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiProviderManagement } from '../../../common/api-providers.js';
import { GarconProcess, isolatedEnvironment } from '../../support/garcon-process.js';
import { prepareFixtureAuth } from '../../support/fixture-auth.js';
import { withTimeout } from '../../support/deferred.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

test.each(['after-initialization', 'partial-assignment-file'] as const)(
  'an interrupted fresh workspace startup never receives legacy provider grants on restart (%s)', async (interruption) => {
  const root = await mkdtemp(join(homedir(), 'provider-startup-'));
  const configDir = join(root, 'config');
  const workspaceDir = join(root, 'workspace');
  const homeDir = join(root, 'home');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: GarconProcess | undefined;
  try {
    await mkdir(join(homeDir, 'tmp'), { recursive: true });
    await prepareFixtureAuth(configDir);
    await writeFile(join(configDir, 'api-providers.json'), JSON.stringify({
      version: 1,
      apiProviders: [{
        id: 'legacy_profile', label: 'Synthetic legacy profile',
        endpoints: [{ id: 'legacy_endpoint', protocol: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'synthetic-model', apiKey: 'synthetic-key' }],
      }],
    }));
    const assignmentsPath = join(workspaceDir, 'api-provider-assignments.json');
    if (interruption === 'partial-assignment-file') {
      await mkdir(workspaceDir);
      await writeFile(assignmentsPath, '', { mode: 0o600 });
    }
    const preload = interruption === 'after-initialization'
      ? ['--preload', './integration-tests/support/fail-after-carryover-init.ts'] : [];
    const failed = Bun.spawn([process.execPath, ...preload,
      'server/main.ts', '--config-dir', configDir, '--workspace-dir', workspaceDir,
      '--port', '0', '--bind-address', '0.0.0.0', '--project-base-dir', root], {
      cwd: REPO, env: isolatedEnvironment(homeDir), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    child = failed;
    const output = new Response(failed.stdout).text();
    const errors = new Response(failed.stderr).text();
    expect(await withTimeout(failed.exited, 15_000, () => 'Synthetic startup failure')).toBe(1);
    const failureLog = await errors;
    if (interruption === 'after-initialization') {
      expect(failureLog).toContain('Synthetic startup failure after workspace initialization');
    } else {
      expect(failureLog).toContain('Restore a valid state file before starting; keep the quarantine');
      expect(failureLog).not.toContain('Restore or remove');
      const quarantines = (await readdir(workspaceDir)).filter(name => name.startsWith('api-provider-assignments.json.corrupt-'));
      expect(quarantines).toHaveLength(1);
      expect(await readFile(join(workspaceDir, quarantines[0]!), 'utf8')).toBe('');
      await writeFile(assignmentsPath, JSON.stringify({ version: 1, revision: 0, assignments: {} }), { mode: 0o600 });
    }
    expect(await output).not.toContain('Started at');
    expect(await Bun.file(join(workspaceDir, 'workspace-version.json')).exists()).toBe(false);

    server = await GarconProcess.start({ repoRoot: REPO, configDir, workspaceDir, homeDir, projectDir: root });
    const response = await fetch(`${server.baseUrl}/api/v1/api-providers`, {
      headers: { Authorization: `Bearer ${server.authToken}` },
    });
    expect(response.status).toBe(200);
    const management = await response.json() as ApiProviderManagement;
    expect(management.providers.map((provider) => provider.id)).toEqual(['legacy_profile']);
    const assignments = JSON.parse(await readFile(assignmentsPath, 'utf8'));
    expect(assignments.assignments).toEqual({});
    const profiles = JSON.parse(await readFile(join(configDir, 'api-providers.json'), 'utf8'));
    expect(profiles.legacyProviderIds).toEqual(['legacy_profile']);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await child?.exited;
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
