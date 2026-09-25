import { afterEach, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { startCliGateway } from '../server/cli-gateway.js';
import { acquireWorkspaceLease } from '../../common/workspace-lease.js';
import { discoverRuntime } from '../../../cli/discovery.js';

let gatewayFailure: 'startup' | 'cleanup' = 'startup';
const fakeGateway: typeof startCliGateway = async ({ dataDir }) => {
  if (gatewayFailure === 'startup') throw new Error('Synthetic gateway startup failure');
  return { runtimeFile: join(dataDir, 'runtime.json'), descriptor: {
    kind: 'executor-cli', schemaVersion: 1, instanceId: 'synthetic-gateway', startedAt: new Date().toISOString(),
    pid: process.pid, baseUrl: 'http://127.0.0.1:1', localCapability: `garcon_local_${Buffer.alloc(32, 1).toString('base64url')}`,
  }, dispose: async () => { throw new Error('Synthetic gateway cleanup failure'); } };
};
mock.module('../server/cli-gateway.js', () => ({ startCliGateway: fakeGateway }));
const { runExecutorWorker } = await import('../worker.js');
const roots: string[] = [];
const environment = { ...process.env };
afterEach(async () => {
  for (const key of ['GARCON_CONFIG_DIR', 'GARCON_RUNTIME', 'GARCON_WORKSPACE', 'GARCON_WORKSPACE_DIR', 'GARCON_CLI_RUNTIME', 'GARCON_AGENT_EXECUTOR_CONFIG']) {
    if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(homedir(), 'worker-lifecycle-'));
  roots.push(root);
  const dataDir = join(root, 'executor');
  await mkdir(dataDir);
  return { root, dataDir, options: { configDir: root, projectBasePath: root, allowInsecureDevelopment: true,
    connection: { kind: 'listen' as const, port: 0, bindAddress: '0.0.0.0' } } };
}

test('gateway startup failure clears stale metadata and keeps children on the unavailable worker role', async () => {
  gatewayFailure = 'startup';
  const f = await fixture();
  await writeFile(join(f.dataDir, 'runtime.json'), 'Synthetic predecessor metadata');
  await writeFile(join(f.root, 'runtime.json'), 'Synthetic controller metadata');
  let checked: Promise<void> | undefined;
  await runExecutorWorker(f.options, () => {
    checked = (async () => {
      try {
        expect(process.env.GARCON_RUNTIME).toBe('executor');
        expect(process.env.GARCON_CONFIG_DIR).toBe(f.root);
        await expect(discoverRuntime({ configDir: f.root, runtime: 'executor' })).rejects.toThrow('no executor runtime file');
        expect(await readFile(join(f.root, 'runtime.json'), 'utf8')).toBe('Synthetic controller metadata');
        await expect(acquireWorkspaceLease(f.dataDir, { retries: 0 })).rejects.toThrow('already in use');
      } finally { process.emit('SIGTERM'); }
    })();
  });
  await checked;
  const lease = await acquireWorkspaceLease(f.dataDir, { retries: 0 });
  await lease.release();
});

test('failure to clear the stale descriptor aborts before listener credential initialization', async () => {
  const f = await fixture();
  await mkdir(join(f.dataDir, 'runtime.json'));
  await writeFile(join(f.dataDir, 'runtime.json', 'blocker'), 'Synthetic blocker');
  await expect(runExecutorWorker(f.options)).rejects.toThrow();
  await expect(stat(join(f.dataDir, 'executor-secret.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const lease = await acquireWorkspaceLease(f.dataDir, { retries: 0 });
  await lease.release();
});

test('gateway cleanup errors do not skip listener shutdown or lease release on startup failure', async () => {
  gatewayFailure = 'cleanup';
  const f = await fixture();
  let port: number | undefined;
  await expect(runExecutorWorker(f.options, (url) => {
    port = Number(new URL(url).port);
    throw new Error('Synthetic onboarding failure');
  })).rejects.toThrow('Synthetic gateway cleanup failure');
  expect(port).toBeDefined();
  const replacement = Bun.serve({ port, hostname: '0.0.0.0', fetch: () => new Response('Synthetic replacement') });
  await replacement.stop(true);
  const lease = await acquireWorkspaceLease(f.dataDir, { retries: 0 });
  await lease.release();
});
