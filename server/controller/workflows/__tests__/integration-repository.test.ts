import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentCallError } from '@garcon/server-agent-interface';
import type { AutomationResult } from '../../../../common/automation.js';
import { RUNTIME_BACKENDS, runtimeAdapter, type RuntimeBackend } from '../../../remote/__tests__/runtime-adapter.js';
import { ExecutionRuntime } from '../../../runtime/execution-runtime.js';
import { runGit } from '../../../runtime/git/run.js';
import { createWorkflowRepositoryPort } from '../adapters/repositories.js';
import { createWorkflowIntegrationPort } from '../adapters/integration.js';
import { WorkflowChatAdmission } from '../admission.js';
import type { WorkflowChatPort } from '../contracts.js';
import { WorkflowAttempts } from '../attempts.js';
import { WorkflowEvidence } from '../evidence.js';
import { WorkflowIntegrationAdmission } from '../integration-admission.js';
import { workflowEffectiveInput, workflowStartInput } from '../inputs.js';
import { WorkflowResources } from '../resources.js';
import { workflowTerminalObservation } from '../terminal-observation.js';
import { browser, effectFence, fixture } from './fixture.js';
import { WorkflowService } from '../service.js';
import { cleanupWorkflowResource } from '../cleanup.js';
import { integrationPlan, replaceTarget } from './integration-fixture.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(backend: RuntimeBackend, mode: 'shared' | 'transfer' | 'conflict' | 'lost', handoff?: 'agent' | 'command') {
  const root = await mkdtemp(join(homedir(), 'tmp', 'workflow-integration-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'source'); const destinationPath = join(root, 'destination'); const worktreeRoot = join(root, 'worktrees');
  await mkdir(sourcePath); await mkdir(worktreeRoot);
  await runGit(sourcePath, ['init', '-b', 'main']);
  await runGit(sourcePath, ['config', 'user.name', 'Synthetic Author']);
  await runGit(sourcePath, ['config', 'user.email', 'synthetic@example.invalid']);
  await writeFile(join(sourcePath, 'input.txt'), 'Synthetic input\n');
  await runGit(sourcePath, ['add', '.']); await runGit(sourcePath, ['commit', '-m', 'Synthetic root']);
  const baseCommit = (await runGit(sourcePath, ['rev-parse', 'HEAD'])).stdout.trim();
  const remoteUrl = `ssh://git@synthetic${join(root, 'remote.git')}`;
  if (mode === 'transfer') {
    await runGit(root, ['init', '--bare', 'remote.git']);
    await runGit(root, ['clone', sourcePath, destinationPath]);
    const ssh = join(root, 'synthetic-ssh.ts');
    await writeFile(ssh, `const args = process.argv.slice(2);
if (args.includes('-G')) process.exit(1);
const match = /^(git-upload-pack|git-receive-pack) '(.*)'$/.exec(args.at(-1) ?? '');
if (!match || match[2] !== ${JSON.stringify(join(root, 'remote.git'))}) process.exit(1);
process.exit(Bun.spawnSync([match[1]!, match[2]!], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }).exitCode);
`);
    for (const projectPath of [sourcePath, destinationPath]) {
      await runGit(projectPath, ['config', 'user.name', 'Synthetic Author']);
      await runGit(projectPath, ['config', 'user.email', 'synthetic@example.invalid']);
      await runGit(projectPath, ['config', 'core.sshCommand', `${JSON.stringify(process.execPath)} ${JSON.stringify(ssh)}`]);
      await runGit(projectPath, ['remote', 'add', 'delivery', remoteUrl]);
    }
  }
  const targetExecutor = mode === 'transfer' ? '11111111-1111-4111-8111-111111111111' : 'local';
  const sourceRuntime = new ExecutionRuntime({ id: 'local', instanceId: 'synthetic-source', workspaceDir: root,
    projectBasePath: root, integrations: [], resolveCredential: async () => null });
  cleanups.push(() => sourceRuntime.dispose());
  const destinationRuntime = mode === 'transfer' ? new ExecutionRuntime({ id: targetExecutor, instanceId: 'synthetic-destination',
    workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null }) : sourceRuntime;
  if (destinationRuntime !== sourceRuntime) cleanups.push(() => destinationRuntime.dispose());
  const adapter = await runtimeAdapter(destinationRuntime, backend); cleanups.push(() => adapter.dispose());
  let destinationExecutor = adapter.executor;
  const resolve = async (executorId: string) => executorId === targetExecutor ? destinationExecutor : sourceRuntime;
  const restart = async () => {
    await adapter.dispose(); await destinationRuntime.dispose();
    const replacement = new ExecutionRuntime({ id: targetExecutor, instanceId: 'synthetic-replacement', workspaceDir: root,
      projectBasePath: root, integrations: [], resolveCredential: async () => null });
    cleanups.push(() => replacement.dispose());
    const replacementAdapter = await runtimeAdapter(replacement, backend);
    cleanups.push(() => replacementAdapter.dispose()); destinationExecutor = replacementAdapter.executor;
  };
  const original = integrationPlan(mode === 'transfer' ? 1 : 2);
  const tasks = original.tasks.map(task => task.id === 'check' && handoff
    ? replaceTarget({ ...task, dependsOn: ['source0'], spec: handoff === 'agent' ? original.tasks[0]!.spec : task.spec }, { inputTaskId: 'source0' }) : task);
  const input = { ...original, policy: { ...original.policy, allowRemoteWrites: mode === 'transfer' }, tasks: tasks.map(task =>
    replaceTarget(task, { baseCommit, worktreeRoot, executorId: task.id.startsWith('source') ? 'local' : targetExecutor,
      projectPath: mode === 'transfer' && !task.id.startsWith('source') ? destinationPath : sourcePath,
      remote: mode === 'transfer' ? { name: 'delivery', url: remoteUrl } : null })) };
  const f = fixture(); cleanups.push(f.cleanup);
  const id = f.write({ action: 'create', captainChatId: null, plan: input }).workflowId; f.activate(id);
  const now = () => new Date().toISOString();
  const attempts = new WorkflowAttempts(f.store, { now }); const resources = new WorkflowResources(f.store, now);
  const repository = createWorkflowRepositoryPort(resources, resolve);
  const evidence = new WorkflowEvidence(f.store, repository, { now });
  for (const [index, task] of input.tasks.filter(task => task.id.startsWith('source')).entries()) {
    let attempt = attempts.beginPreparation(attempts.reserve(id, task.id)!.attemptId);
    const prepared = await repository.prepare(attempt, task, effectFence());
    if (prepared.kind !== 'prepared') throw new Error('Synthetic preparation failed.');
    attempt = attempts.bindTarget(attempt.attemptId, prepared.resource);
    const key = { serverInstanceId: 'synthetic-controller', chatId: `${index + 1}234567890123456`, turnId: `synthetic-turn-${index}`, clientRequestId: attempt.requestId };
    attempt = attempts.bindPrepared(attempt.attemptId, key, workflowEffectiveInput(workflowStartInput(attempt, task)));
    attempts.markDispatching(attempt.attemptId, effectFence());
    await writeFile(join(prepared.resource.target.projectPath, mode === 'conflict' ? 'input.txt' : `output-${index}.txt`), `Synthetic output ${index}\n`);
    await runGit(prepared.resource.target.projectPath, ['add', '.']);
    await runGit(prepared.resource.target.projectPath, ['commit', '-m', `Synthetic output ${index}`]);
    const terminal: AutomationResult = { kind: 'completed', executionScope: { executorId: 'local', instanceId: prepared.resource.instanceId },
      commandOutcome: null, receivedOutputCoverage: 'complete', receipt: { ...key, state: 'completed', acceptedAt: now(), updatedAt: now(), settledAt: now(),
        output: { availability: 'unavailable', reason: 'no-final-response' } } };
    attempt = attempts.observe(attempt.attemptId, workflowTerminalObservation(task, terminal), effectFence());
    (await evidence.capture(attempt, task, terminal, { ...effectFence(), outputGapped: false }, new AbortController().signal)).commit();
  }
  const sourceEvidence = f.service.detail(id).artifacts;
  const integration = createWorkflowIntegrationPort(resolve);
  const controls = { beforeIntegrationPrepare: async () => {} };
  let calls = 0;
  const admission = new WorkflowIntegrationAdmission(attempts, resources, repository, { ...integration, async prepare(manifest, shutdown) {
    await controls.beforeIntegrationPrepare();
    const prepared = await integration.prepare(manifest, shutdown);
    return { async run() {
      calls++;
      const result = await prepared.run();
      if (mode === 'lost') throw new AgentCallError('unknown', 'Synthetic lost integrated reply.');
      return result;
    } };
  } }, { now });
  const attempt = attempts.reserve(id, 'integrate')!;
  return { ...f, id, attempt, attempts, resources, repository, evidence, admission, input, sourceEvidence, controls, restart, resolve, now, calls: () => calls };
}

for (const backend of RUNTIME_BACKENDS) describe(`workflow integration (${backend})`, () => {
  test.each([false, true])('explicit archived cleanup preserves evidence and refuses replacement runtimes (%s)', async restarted => {
    const f = await setup(backend, 'shared');
    await f.admission.dispatch(f.attempt, effectFence());
    f.write({ action: 'pause', workflowId: f.id }); f.write({ action: 'archive', workflowId: f.id });
    if (restarted) await f.restart();
    const current = f.attempts.get(f.attempt.attemptId);
    const resource = current.managedTarget!;
    const before = f.service.artifacts(f.id);
    const output = before.find(artifact => artifact.attempt.attemptId === current.attemptId)!;
    let calls = 0;
    const service = new WorkflowService(f.store, { enabled: () => false, now: f.now,
      async cleanup(id) { calls++; await cleanupWorkflowResource(f.store, id, f.resolve, new AbortController().signal,
        { now: f.now, onInvalidated() {}, async inspectWriters() {} }); } });
    const request = { operationId: crypto.randomUUID(), expectedStoreId: service.bootstrap().storeId, mutation: {
      action: 'cleanup' as const, workflowId: f.id, attemptId: current.attemptId, resourceKey: resource.resourceKey, expectedHead: output.commit! } };
    const result = await service.executeHttp(request, browser);
    expect(await service.executeHttp(request, browser)).toEqual(result); expect(calls).toBe(1);
    expect(f.resources.get(request.operationId).status).toBe(restarted ? 'not-started' : 'succeeded');
    expect(service.detail(f.id).resources.some(claim => claim.resourceKey === resource.resourceKey)).toBe(restarted);
    expect(service.artifacts(f.id)).toEqual(before);
    expect(await Bun.file(join(resource.target.projectPath, 'output-0.txt')).exists()).toBe(restarted);
    expect((await runGit(resource.sourceProjectPath, ['rev-parse', `refs/heads/${resource.branch}`])).stdout.trim()).toBe(output.commit!);
  }, 30_000);
  test.each(['agent', 'command'] as const)('%s admission transfers exact input before chat preparation', async kind => {
    const f = await setup(backend, 'transfer', kind);
    const consumer = f.attempts.reserve(f.id, 'check')!;
    const before = f.store.read(db => ({ attempts: db.query("SELECT * FROM attempts WHERE task_id LIKE 'source%'").all(),
      claims: db.query("SELECT * FROM resource_claims WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id LIKE 'source%')").all() }));
    let preparations = 0;
    const chats = {
      async prepare(input) {
        preparations++;
        expect((await runGit(input.projectPath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(consumer.target!.baseCommit);
        return { kind: 'rejected', code: 'SYNTHETIC_PREPARATION_REJECTION' };
      },
      async waitForTerminal() { throw new Error('Synthetic chat was not dispatched.'); },
      async stop() { return { kind: 'not-started' }; },
      async waitForOwnershipRelease() {},
      async inspect() { return { exists: false, ownsExecution: false, pendingInput: false }; },
    } satisfies WorkflowChatPort;
    const admission = new WorkflowChatAdmission(f.attempts, chats, f.repository, f.evidence,
      { onRevoked() {}, onFailure(error) { throw error; } });
    await admission.dispatch(consumer, effectFence());
    expect(preparations).toBe(1);
    expect(f.attempts.get(consumer.attemptId).resolution).toBe('not-started');
    expect(f.store.read(db => db.query("SELECT status FROM operation_intents WHERE attempt_id=? AND kind='transfer'").all(consumer.attemptId)))
      .toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
    expect(f.service.detail(f.id).artifacts).toEqual(f.sourceEvidence);
    expect(f.store.read(db => ({ attempts: db.query("SELECT * FROM attempts WHERE task_id LIKE 'source%'").all(),
      claims: db.query("SELECT * FROM resource_claims WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id LIKE 'source%')").all() }))).toEqual(before);
  }, 30_000);

  test('same-clone inputs survive restart before preparation', async () => {
    const f = await setup(backend, 'shared');
    await f.restart();
    await f.admission.dispatch(f.attempt, effectFence());
    expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'succeeded', managedTarget: { instanceId: 'synthetic-replacement' } });
    expect(f.service.detail(f.id).artifacts.filter(artifact => artifact.attempt.taskId.startsWith('source'))).toEqual(f.sourceEvidence);
  }, 30_000);

  test('restart after preparation cannot mutate the old runtime-bound worktree', async () => {
    const f = await setup(backend, 'shared');
    f.controls.beforeIntegrationPrepare = f.restart;
    await f.admission.dispatch(f.attempt, effectFence());
    const attempt = f.attempts.get(f.attempt.attemptId);
    expect(attempt).toMatchObject({ resolution: 'not-started', managedTarget: { instanceId: 'synthetic-source' } });
    expect((await runGit(attempt.managedTarget!.target.projectPath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(attempt.managedTarget!.head);
    expect(f.service.detail(f.id).artifacts).toEqual(f.sourceEvidence);
  }, 30_000);

  test.each(['shared', 'transfer', 'conflict', 'lost'] as const)('%s uses exact runtime primitives without replay', async mode => {
    const f = await setup(backend, mode);
    await f.admission.dispatch(f.attempt, effectFence());
    const attempt = f.attempts.get(f.attempt.attemptId);
    expect(attempt.resolution).toBe(mode === 'conflict' ? 'failed' : mode === 'lost' ? 'unknown' : 'succeeded');
    expect(f.calls()).toBe(1);
    const artifacts = f.service.detail(f.id).artifacts;
    expect(artifacts.filter(artifact => artifact.attempt.taskId.startsWith('source'))).toEqual(f.sourceEvidence);
    const integrated = artifacts.find(artifact => artifact.attempt.taskId === 'integrate');
    if (mode === 'shared' || mode === 'transfer') {
      expect(integrated).toMatchObject({ kind: 'commit', outcome: 'pass', git: { scope: 'managed-integration' } });
      const consumer = f.attempts.beginPreparation(f.attempts.reserve(f.id, 'check')!.attemptId);
      expect(consumer.target!.baseCommit).toBe(integrated!.commit!);
      expect((await f.repository.prepare(consumer, f.input.tasks.find(task => task.id === 'check')!, effectFence())).kind).toBe('prepared');
    } else expect(integrated).toBeUndefined();
    const transfers = f.store.read(db => db.query('SELECT status FROM operation_intents WHERE attempt_id=? AND kind=\'transfer\'').all(attempt.attemptId));
    expect(transfers).toHaveLength(mode === 'transfer' ? 2 : 0);
    if (mode === 'transfer') expect(transfers).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
  }, 30_000);
});
