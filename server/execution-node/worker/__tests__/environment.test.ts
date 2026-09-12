import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareNodeInstanceEnvironments as prepareEnvironments } from '../environment.js';
import type { NodeInstanceConfiguration } from '../configuration.js';

function prepareNodeInstanceEnvironments(instances: readonly NodeInstanceConfiguration[], signal: AbortSignal) {
  return prepareEnvironments(instances, signal, async (integrationId) => ({ integrationId, directories: [] }));
}

function instance(directory: string, id: string): NodeInstanceConfiguration {
  return { id, agentId: 'synthetic', label: 'Synthetic', homeDirectory: path.join(directory, id),
    workspaceIds: [], maxOperations: 1, environment: { SYNTHETIC_INSTANCE_KEY: id } };
}

test('two real child processes have independent native homes and no inherited credentials', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-instance-environments-'));
  const inherited = process.env.SYNTHETIC_COORDINATOR_CREDENTIAL;
  process.env.SYNTHETIC_COORDINATOR_CREDENTIAL = 'synthetic-private-controller';
  try {
    const environments = await prepareNodeInstanceEnvironments([instance(root, 'first'), instance(root, 'second')], new AbortController().signal);
    for (const [id, environment] of environments) {
      const child = Bun.spawn([process.execPath, '-e', `
        import os from 'node:os';
        console.log(JSON.stringify({ home: os.homedir(), tmp: os.tmpdir(), key: process.env.SYNTHETIC_INSTANCE_KEY,
          inherited: process.env.SYNTHETIC_COORDINATOR_CREDENTIAL ?? null, runtime: process.env.XDG_RUNTIME_DIR }));
      `], { env: { ...environment.values }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [output, diagnostic, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(code, diagnostic).toBe(0);
        expect(JSON.parse(output)).toEqual({ home: path.join(root, id), tmp: path.join(root, id, '.tmp'),
          key: id, inherited: null, runtime: path.join(root, id, '.run') });
      } finally { clearTimeout(deadline); }
    }
  } finally {
    if (inherited === undefined) delete process.env.SYNTHETIC_COORDINATOR_CREDENTIAL;
    else process.env.SYNTHETIC_COORDINATOR_CREDENTIAL = inherited;
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical aliases cannot give two instances the same native home', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-instance-alias-'));
  try {
    await mkdir(path.join(root, 'first'), { mode: 0o700 });
    await symlink(path.join(root, 'first'), path.join(root, 'second'));
    await expect(prepareNodeInstanceEnvironments([instance(root, 'first'), instance(root, 'second')], new AbortController().signal))
      .rejects.toThrow('private, distinct directories');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an escaping native subdirectory is rejected before any directory is created through it', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-instance-escape-'));
  try {
    await mkdir(path.join(root, 'first'), { mode: 0o700 });
    await mkdir(path.join(root, 'outside'), { mode: 0o700 });
    await symlink(path.join(root, 'outside'), path.join(root, 'first', '.local'));
    await expect(prepareNodeInstanceEnvironments([instance(root, 'first')], new AbortController().signal)).rejects.toThrow('Invalid instance private directory');
    expect(await readdir(path.join(root, 'outside'))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelled configuration creates no native home', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-instance-cancel-'));
  try {
    await expect(prepareNodeInstanceEnvironments([instance(root, 'first')], AbortSignal.abort())).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([
  ['claude', 'CLAUDE_CONFIG_DIR', '.claude'], ['codex', 'CODEX_HOME', '.codex'],
  ['factory', 'FACTORY_HOME_OVERRIDE', '.'], ['pi', 'PI_CODING_AGENT_DIR', '.pi/agent'],
  ['pi', 'PI_CODING_AGENT_SESSION_DIR', '.pi/agent/sessions'],
])('provider %s native environment %s is anchored to each isolated home', async (agentId, key, directory) => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-native-environment-'));
  try {
    const instances = ['first', 'second'].map((id) => ({ ...instance(root, id), agentId: agentId! }));
    const environments = await prepareEnvironments(instances, new AbortController().signal);
    for (const [id, environment] of environments) {
      expect(environment.values[key!]).toBe(path.resolve(root, id, directory!));
    }
    await expect(prepareEnvironments([{ ...instances[0]!, environment: { [key!]: path.join(root, 'shared') } }], new AbortController().signal))
      .rejects.toThrow('overrides are owned');
    expect(await readdir(root)).not.toContain('shared');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider native paths cannot escape through a preexisting symlink', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-native-environment-escape-'));
  try {
    await mkdir(path.join(root, 'first'), { mode: 0o700 });
    await mkdir(path.join(root, 'outside'), { mode: 0o700 });
    await symlink(path.join(root, 'outside'), path.join(root, 'first', '.factory'));
    await expect(prepareEnvironments([{ ...instance(root, 'first'), agentId: 'factory' }], new AbortController().signal))
      .rejects.toThrow('Invalid instance private directory');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider native environment metadata is validated before filesystem effects', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-native-environment-invalid-'));
  try {
    for (const directory of ['', '../outside', '/outside', 'nested/../outside', 'nested\\outside']) {
      await expect(prepareEnvironments([instance(root, 'first')], new AbortController().signal,
        async (integrationId) => ({ integrationId, directories: [{ path: directory, environmentKey: 'SYNTHETIC_HOME' }] })))
        .rejects.toThrow('Invalid provider native environment');
    }
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(['PATH', 'LANG'])('provider native metadata cannot replace the worker-owned %s', async (environmentKey) => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-native-environment-owned-'));
  try {
    await expect(prepareEnvironments([instance(root, 'first')], new AbortController().signal,
      async (integrationId) => ({ integrationId, directories: [{ path: '.', environmentKey }] })))
      .rejects.toThrow('Invalid provider native environment');
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('direct environment preparation preserves worker-owned search path and locale', async () => {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-native-environment-defaults-'));
  try {
    const input = { ...instance(root, 'first'), environment: { PATH: '/synthetic/foreign-bin', LANG: 'synthetic-foreign-locale' } };
    const environments = await prepareNodeInstanceEnvironments([input], new AbortController().signal);
    expect(environments.get('first')?.values).toMatchObject({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
