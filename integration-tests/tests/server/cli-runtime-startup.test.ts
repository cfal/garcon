import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireControllerLease } from '../../../server/controller/lib/workspace-lease.js';
import { isolatedEnvironment } from '../../support/garcon-process.js';
import { withTimeout } from '../../support/deferred.js';
import { rejectionOf } from '../../support/promise-assertions.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/controller/migrations/index.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

test.each(['missing', 'null', '[]', '{"version":5,"sessions":null}'])('startup preserves ledgers with %s registry', async (raw) => {
  const root = await mkdtemp(join(homedir(), 'registry-startup-'));
  const workspaceDir = join(root, 'workspace');
  const home = join(root, 'home');
  await mkdir(workspaceDir);
  await mkdir(join(home, 'tmp'), { recursive: true });
  await writeFile(join(workspaceDir, 'workspace-version.json'), JSON.stringify({ version: CURRENT_WORKSPACE_VERSION }));
  await writeFile(join(workspaceDir, 'api-provider-assignments.json'), JSON.stringify({ version: 1, revision: 0, assignments: {} }));
  const registryPath = join(workspaceDir, 'chats.json');
  if (raw !== 'missing') await writeFile(registryPath, raw);
  const ledgerRoot = join(workspaceDir, 'transcript-ledgers');
  const chatId = '1783725900000201';
  const ledger = new TranscriptLedgerStore(ledgerRoot);
  ledger.initializeCurrentView(chatId, { viewId: transcriptViewId('synthetic-view'), contentStartOrdinal: 1,
    rows: [{ kind: 'notice', at: '2026-10-02T00:00:00.000Z', message: 'Synthetic history', detail: {} }] });
  ledger.close();
  const ledgerPath = join(ledgerRoot, chatId, 'ledger.sqlite');
  const before = await readFile(ledgerPath);
  const child = Bun.spawn([process.execPath, 'server/main.ts', '--config-dir', join(root, 'config'),
    '--workspace-dir', workspaceDir, '--port', '0', '--bind-address', '0.0.0.0', '--project-base-dir', root],
  { cwd: REPO, env: isolatedEnvironment(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  try {
    expect(await withTimeout(child.exited, 15_000, () => 'registry startup failure')).toBe(1);
    expect(await errors).toContain('chats.json');
    await output;
    expect(await readFile(ledgerPath)).toEqual(before);
    if (raw === 'missing') expect(await rejectionOf(stat(registryPath))).toMatchObject({ code: 'ENOENT' });
    else expect(await readFile(registryPath, 'utf8')).toBe(raw);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test.each(['occupied-port', 'unclearable-runtime'] as const)('controller runtime cleanup fails closed on %s', async (failure) => {
  const root = await mkdtemp(join(homedir(), 'cli-runtime-startup-'));
  const configDir = join(root, 'config');
  const workspaceDir = join(root, 'workspace');
  const runtimeFile = join(configDir, 'runtime.json');
  const home = join(root, 'home');
  await mkdir(configDir);
  await mkdir(join(home, 'tmp'), { recursive: true });
  const occupied = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('Synthetic occupied port') });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    if (failure === 'unclearable-runtime') {
      await mkdir(runtimeFile);
      await writeFile(join(runtimeFile, 'blocker'), 'Synthetic blocker');
    } else {
      await writeFile(runtimeFile, JSON.stringify({
        schemaVersion: 1, instanceId: 'synthetic-predecessor', workspaceDir, pid: process.pid,
        baseUrl: `http://127.0.0.1:${occupied.port}`, startedAt: '2099-01-01T00:00:00.000Z',
        localCapability: `garcon_local_${Buffer.alloc(32, 1).toString('base64url')}`,
      }), { mode: 0o600 });
    }
    const processHandle = Bun.spawn([process.execPath, 'server/main.ts', '--config-dir', configDir,
      '--workspace-dir', workspaceDir, '--port', String(occupied.port), '--bind-address', '0.0.0.0',
      '--project-base-dir', root], { cwd: REPO, env: isolatedEnvironment(home), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    child = processHandle;
    const output = new Response(processHandle.stdout).text();
    const errors = new Response(processHandle.stderr).text();
    expect(await withTimeout(processHandle.exited, 15_000, () => 'controller startup failure')).toBe(1);
    expect(await errors).toContain('Failed to start server');
    expect(await output).not.toContain('Published controller runtime');
    if (failure === 'occupied-port') {
      expect(await rejectionOf(stat(runtimeFile))).toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(join(runtimeFile, 'blocker'), 'utf8')).toBe('Synthetic blocker');
      expect(await rejectionOf(stat(join(workspaceDir, 'workspace-version.json')))).toMatchObject({ code: 'ENOENT' });
    }
    const lease = await acquireControllerLease(configDir, workspaceDir, { retries: 0 });
    await lease.release();
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await child?.exited;
    await occupied.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
