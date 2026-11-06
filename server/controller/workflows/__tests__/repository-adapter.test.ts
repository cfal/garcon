import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentCallError } from '@garcon/server-agent-interface';
import { RUNTIME_BACKENDS, runtimeAdapter, type RuntimeBackend } from '../../../remote/__tests__/runtime-adapter.js';
import { ExecutionRuntime } from '../../../runtime/execution-runtime.js';
import { runGit } from '../../../runtime/git/run.js';
import { createWorkflowRepositoryPort } from '../adapters/repositories.js';
import { WorkflowAttempts } from '../attempts.js';
import { WorkflowResources } from '../resources.js';
import { WorkflowEvidence } from '../evidence.js';
import { workflowEffectiveInput, workflowStartInput } from '../inputs.js';
import { workflowTerminalObservation } from '../terminal-observation.js';
import type { AutomationResult } from '../../../../common/automation.js';
import type { WorkflowPlanTask } from '../../../../common/workflows.js';
import { effectFence, fixture, plan } from './fixture.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(backend: RuntimeBackend, dependent = false) {
  const root = await mkdtemp(join(homedir(), 'tmp', 'workflow-repository-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, 'repo'); const worktreeRoot = join(root, 'worktrees');
  await mkdir(projectPath); await mkdir(worktreeRoot);
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.name', 'Synthetic Author']);
  await runGit(projectPath, ['config', 'user.email', 'synthetic@example.invalid']);
  await writeFile(join(projectPath, 'input.txt'), 'Synthetic input\n');
  await runGit(projectPath, ['add', '.']);
  await runGit(projectPath, ['commit', '-m', 'Synthetic input']);
  const baseCommit = (await runGit(projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
  const f = fixture(); cleanups.push(() => f.cleanup());
  const original = plan().tasks[0]!;
  if (original.spec.kind !== 'command') throw new Error('Synthetic task kind.');
  const check = { ...original, spec: { ...original.spec, target: { ...original.spec.target, projectPath, worktreeRoot, baseCommit } } };
  const task: WorkflowPlanTask = dependent ? { ...check, id: 'implement', spec: { kind: 'agent', target: check.spec.target,
    prompt: 'Synthetic implementation.', outputs: ['commit'], selection: { agentId: 'codex', model: 'synthetic',
      apiProviderId: null, modelEndpointId: null, modelProtocol: null, providerRevision: null, permissionMode: 'default',
      thinkingMode: 'none', preambles: [], agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} } } } } : check;
  const downstream = { ...check, dependsOn: ['implement'], spec: { ...check.spec, target: { ...check.spec.target, inputTaskId: 'implement' } } };
  const id = f.write({ action: 'create', captainChatId: null, plan: { ...plan(), tasks: dependent ? [task, downstream] : [task] } }).workflowId;
  f.activate(id);
  const runtime = new ExecutionRuntime({ id: 'local', instanceId: 'synthetic-runtime', workspaceDir: root,
    projectBasePath: root, integrations: [], resolveCredential: async () => null });
  cleanups.push(() => runtime.dispose());
  const adapter = await runtimeAdapter(runtime, backend); cleanups.push(() => adapter.dispose());
  const git = await adapter.executor.getGitService();
  const attempts = new WorkflowAttempts(f.store, { now: () => new Date().toISOString() });
  const resources = new WorkflowResources(f.store, () => new Date().toISOString());
  const attempt = attempts.beginPreparation(attempts.reserve(id, task.id)!.attemptId);
  const requested: string[] = [];
  const port = createWorkflowRepositoryPort(resources, async executorId => { requested.push(executorId); return adapter.executor; });
  return { ...f, root, projectPath, task, downstream, baseCommit, git, executor: adapter.executor, attempt, attempts, resources, port, requested };
}

for (const backend of RUNTIME_BACKENDS) describe(`workflow repository (${backend})`, () => {
  test('a downstream check is prepared at the accepted dependency commit rather than the approved root', async () => {
    const f = await setup(backend, true);
    const prepared = await f.port.prepare(f.attempt, f.task, effectFence());
    if (prepared.kind !== 'prepared') throw new Error('Synthetic preparation failed.');
    let attempt = f.attempts.bindTarget(f.attempt.attemptId, prepared.resource);
    const key = { serverInstanceId: 'synthetic-controller', chatId: '1234567890123456', turnId: 'synthetic-turn', clientRequestId: attempt.requestId };
    attempt = f.attempts.bindPrepared(attempt.attemptId, key, workflowEffectiveInput(workflowStartInput(attempt, f.task)));
    f.attempts.markDispatching(attempt.attemptId, effectFence());
    await writeFile(join(prepared.resource.target.projectPath, 'output.txt'), 'Synthetic implementation\n');
    await runGit(prepared.resource.target.projectPath, ['add', '.']);
    await runGit(prepared.resource.target.projectPath, ['commit', '-m', 'Synthetic implementation']);
    const head = (await runGit(prepared.resource.target.projectPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const terminal: AutomationResult = { kind: 'completed', executionScope: { executorId: 'local', instanceId: 'synthetic-runtime' },
      commandOutcome: null, receivedOutputCoverage: 'complete', receipt: { ...key, state: 'completed', acceptedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z', settledAt: '2026-01-01T00:00:00.000Z', output: { availability: 'unavailable', reason: 'no-final-response' } } };
    const fence = { ...effectFence(), outputGapped: false };
    attempt = f.attempts.observe(attempt.attemptId, { ...workflowTerminalObservation(f.task, terminal), retainControl: true }, fence);
    const evidence = new WorkflowEvidence(f.store, f.port, { now: () => new Date().toISOString() });
    (await evidence.capture(attempt, f.task, terminal, fence, new AbortController().signal)).commit();
    const check = f.attempts.beginPreparation(f.attempts.reserve(attempt.workflowId, 'check')!.attemptId);
    expect(check.target!.baseCommit).toBe(head);
    expect(check.target!.baseCommit).not.toBe(f.baseCommit);
    const checked = await f.port.prepare(check, f.downstream, effectFence());
    expect(checked).toMatchObject({ kind: 'prepared', resource: { head } });
  }, 15_000);
  test('prepares and inspects a separate exact managed input on the selected runtime', async () => {
    const f = await setup(backend);
    const prepared = await f.port.prepare(f.attempt, f.task, effectFence());
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('Synthetic preparation failed.');
    const bound = f.attempts.bindTarget(f.attempt.attemptId, prepared.resource);
    expect(bound.target!.projectPath).not.toBe(f.projectPath);
    const observed = await f.port.inspect(prepared.resource, new AbortController().signal);
    expect(observed).toMatchObject({ executorId: 'local', instanceId: 'synthetic-runtime',
      managed: { head: f.baseCommit, dirty: false }, commit: { containsAncestor: true } });
    expect(prepared.resource.baseTree).toBe(observed.commit.tree);
    expect(f.resources.get(prepared.resource.operationId).status).toBe('succeeded');
    expect(f.requested).toEqual(['local', 'local']);
    await expect(f.port.prepare(f.attempt, f.task, effectFence())).rejects.toThrow('repeat');
  });

  test('a lost creation reply retains its intent and cannot create a replacement', async () => {
    const f = await setup(backend); let creates = 0;
    const port = createWorkflowRepositoryPort(f.resources, async () => ({
      getProjectService: options => f.executor.getProjectService(options),
      getGitService: async () => ({ ...f.git,
        async createManagedWorktree(input, options) {
          creates++;
          await f.git.createManagedWorktree(input, options);
          throw new AgentCallError('unknown', 'Synthetic lost reply.');
        },
      }),
    }));
    expect((await port.prepare(f.attempt, f.task, effectFence())).kind).toBe('unknown');
    expect(f.store.read(db => db.query('SELECT status FROM operation_intents').all())).toEqual([{ status: 'unknown' }]);
    expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 1 }]);
    await expect(port.prepare(f.attempt, f.task, effectFence())).rejects.toThrow('repeat');
    expect(creates).toBe(1);
  });

  test('replacement between inspection and creation cannot create a managed resource', async () => {
    const f = await setup(backend);
    const replacement = new ExecutionRuntime({ id: 'local', instanceId: 'replacement-runtime', workspaceDir: f.root,
      projectBasePath: f.root, integrations: [], resolveCredential: async () => null });
    cleanups.push(() => replacement.dispose());
    const adapter = await runtimeAdapter(replacement, backend); cleanups.push(() => adapter.dispose());
    const replacementGit = await adapter.executor.getGitService();
    const port = createWorkflowRepositoryPort(f.resources, async () => ({
      getProjectService: options => f.executor.getProjectService(options),
      getGitService: async () => ({ ...f.git,
        async createManagedWorktree(input, options) {
          expect(options?.instanceId).toBe('synthetic-runtime');
          return replacementGit.createManagedWorktree(input, options);
        },
      }),
    }));
    expect(await port.prepare(f.attempt, f.task, effectFence())).toMatchObject({ kind: 'not-started' });
    expect(f.store.read(db => db.query('SELECT status FROM operation_intents').all())).toEqual([{ status: 'not-started' }]);
    expect(await readdir(f.attempt.target!.worktreeRoot)).toEqual([]);
    expect((await runGit(f.projectPath, ['for-each-ref', '--format=%(refname)', 'refs/heads/garcon/workflows/'])).stdout.trim()).toBe('');
    expect((await runGit(f.projectPath, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  test('output inspection rejects runtime replacement and observes dirty state without mutation', async () => {
    const f = await setup(backend);
    const prepared = await f.port.prepare(f.attempt, f.task, effectFence());
    if (prepared.kind !== 'prepared') throw new Error('Synthetic preparation failed.');
    await writeFile(join(prepared.resource.target.projectPath, 'untracked.txt'), 'Synthetic dirty output\n');
    expect((await f.port.inspect(prepared.resource, new AbortController().signal)).managed.dirty).toBe(true);
    await expect(f.port.inspect({ ...prepared.resource, instanceId: 'different-runtime' }, new AbortController().signal))
      .rejects.toThrow('prepared runtime');
  });

  test('an unavailable selected executor never falls back to Local', async () => {
    const f = await setup(backend); const calls: string[] = [];
    const port = createWorkflowRepositoryPort(f.resources, async id => { calls.push(id); throw new AgentCallError('not-dispatched', 'Synthetic offline executor.'); });
    const attempt = { ...f.attempt, target: { ...f.attempt.target!, executorId: '11111111-1111-4111-8111-111111111111' } };
    await expect(port.prepare(attempt, f.task, effectFence())).rejects.toThrow('offline');
    expect(calls).toEqual([attempt.target.executorId]);
    expect(f.store.read(db => db.query('SELECT * FROM operation_intents').all())).toHaveLength(0);
  });

  test('a worktree root nested inside a checkout rejects before reservation', async () => {
    const f = await setup(backend);
    const worktreeRoot = join(f.projectPath, 'nested'); await mkdir(worktreeRoot);
    await expect(f.port.prepare({ ...f.attempt, target: { ...f.attempt.target!, worktreeRoot } }, f.task, effectFence()))
      .rejects.toThrow('outside every checkout');
    expect(f.store.read(db => db.query('SELECT * FROM operation_intents').all())).toHaveLength(0);
  });

  test.each(['missing', 'missing-nested', 'symlink'] as const)('%s worktree root rejects before reservation', async kind => {
    const f = await setup(backend);
    const worktreeRoot = join(kind === 'missing-nested' ? f.projectPath : f.root, 'destination');
    if (kind === 'symlink') await symlink(f.attempt.target!.worktreeRoot, worktreeRoot);
    await expect(f.port.prepare({ ...f.attempt, target: { ...f.attempt.target!, worktreeRoot } }, f.task, effectFence()))
      .rejects.toThrow();
    expect(f.store.read(db => db.query('SELECT * FROM operation_intents').all())).toHaveLength(0);
    expect(f.store.read(db => db.query('SELECT * FROM resource_claims').all())).toHaveLength(0);
  });

  test('revocation after planning leaves definite non-dispatch, not an unknown creation', async () => {
    const f = await setup(backend);
    const fence = { ...effectFence(), get revoked() {
      return f.store.read(db => !!db.query('SELECT 1 FROM operation_intents LIMIT 1').get());
    } };
    await expect(f.port.prepare(f.attempt, f.task, fence)).rejects.toThrow('no longer authorized');
    expect(f.store.read(db => db.query('SELECT status FROM operation_intents').all())).toEqual([{ status: 'planned' }]);
    f.resources.interruptPreparation(f.attempt.attemptId);
    expect(f.store.read(db => db.query('SELECT status FROM operation_intents').all())).toEqual([{ status: 'not-started' }]);
    expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims').all())).toEqual([{ quarantined: 0 }]);
    expect((await runGit(f.projectPath, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)).toHaveLength(1);
  });
});
