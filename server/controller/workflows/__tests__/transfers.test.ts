import { afterEach, expect, test } from 'bun:test';
import { AgentCallError, type ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import { GitServiceError } from '../../../../common/git-error.js';
import { WORKFLOW_LIMITS } from '../../../../common/workflows.js';
import { ExecutionRuntime } from '../../../runtime/execution-runtime.js';
import { prepareWorkflowInputs } from '../adapters/transfers.js';
import { readWorkflowCommitSources } from '../commit-inputs.js';
import { workflowDigest } from '../inputs.js';
import { WorkflowIntegrationAdmission } from '../integration-admission.js';
import type { WorkflowIntegrationRepositoryPort, WorkflowRepositoryPort } from '../contracts.js';
import { effectFence } from './fixture.js';
import { integrationFixture, integrationPlan, observedRepository, replaceTarget } from './integration-fixture.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(mode: 'local' | 'clone' | 'remote' = 'remote', phase: 'planned' | 'preparing' = 'preparing') {
  const initial = integrationPlan(1);
  const input = { ...initial, policy: { ...initial.policy, allowRemoteWrites: mode !== 'local' }, tasks: initial.tasks.map(task =>
    replaceTarget(task, { remote: mode === 'local' ? null : { name: task.id === 'source0' ? 'source' : 'destination', url: 'https://example.invalid/synthetic.git' },
      ...(task.id === 'source0' && mode !== 'local' ? { projectPath: '/synthetic/source',
        executorId: mode === 'remote' ? '11111111-1111-4111-8111-111111111111' : 'local' } : {}) })) };
  const f = integrationFixture(input); cleanups.push(f.cleanup); await f.produce();
  const reserved = f.attempts.reserve(f.id, 'integrate')!;
  const attempt = phase === 'preparing' ? f.attempts.beginPreparation(reserved.attemptId) : reserved;
  const source = f.store.read(db => readWorkflowCommitSources(db, attempt, f.task))[0]!;
  const runtime = new ExecutionRuntime({ id: 'local', instanceId: 'synthetic-runtime', workspaceDir: f.directory,
    projectBasePath: f.directory, integrations: [], resolveCredential: async () => null });
  cleanups.push(() => runtime.dispose());
  const base = await runtime.getGitService();
  const controls = { inspectionError: false, destinationError: false, lineage: true, push: 'ok', fetch: 'ok', instanceId: 'synthetic-runtime', dirty: false,
    afterPush: () => {} };
  const calls: string[] = [];
  let transferred = false;
  const services = new Map<string, Awaited<ReturnType<ExecutionRuntimeApi['getGitService']>>>();
  const service = (executorId: string) => {
    const existing = services.get(executorId); if (existing) return existing;
    const scope = { executorId, instanceId: 'synthetic-runtime' };
    const git = { ...base,
      async inspectManagedWorktree() {
        if (controls.inspectionError) throw new Error('Synthetic inspection failure.');
        return { ...scope, instanceId: controls.instanceId,
          managed: { ...observedRepository(source.managed, source.input.commit).managed, dirty: controls.dirty } };
      },
      async inspectCommit(request) {
        const isDestination = request.projectPath === attempt.target!.projectPath;
        if (isDestination) {
          calls.push('inspect-destination');
          if (controls.destinationError) throw new GitServiceError('GIT_INVALID_INPUT', 'Synthetic missing object.');
          expect(mode === 'local' || transferred).toBe(true);
        }
        return { ...scope, instanceId: controls.instanceId, commit: request.commit, tree: source.outputTree, parents: [], containsAncestor: !isDestination || controls.lineage };
      },
      async pushExactRef(request, options) {
        expect(options?.instanceId).toBe(source.managed.instanceId);
        calls.push('push');
        expect(request).toMatchObject({ expectedRemoteCommit: null, commit: source.input.commit,
          projectPath: source.managed.sourceProjectPath, remote: 'source', expectedRemoteUrl: 'https://example.invalid/synthetic.git' });
        expect(request.ref).toStartWith('refs/heads/garcon/transfers/');
        const intents = f.store.read(db => db.query<{ status: string }, [string]>(
          "SELECT status FROM operation_intents WHERE attempt_id=? AND kind='transfer' ORDER BY rowid").all(attempt.attemptId));
        expect(intents).toEqual([{ status: 'dispatching' }, { status: 'planned' }]);
        if (controls.push === 'lost') throw new AgentCallError('unknown', 'Synthetic lost push.');
        if (controls.push === 'stale') throw new AgentCallError('not-dispatched', 'Synthetic replacement before push.', 'STALE_RESOURCE');
        if (controls.push === 'stale-unknown') throw new AgentCallError('unknown', 'Synthetic unconfirmed stale response.', 'STALE_RESOURCE');
        if (controls.push === 'rejected') throw new GitServiceError('GIT_INVALID_INPUT', 'Synthetic URL mismatch.');
        controls.afterPush();
        return { ...scope, success: true, ref: request.ref,
          commit: controls.push === 'sha' ? 'f'.repeat(40) : request.commit,
          ...(controls.push === 'runtime' ? { instanceId: 'different' } : {}) };
      },
      async fetchExactRef(request, options) {
        expect(options?.instanceId).toBe(controls.instanceId);
        calls.push('fetch');
        expect(request).toMatchObject({ commit: source.input.commit, projectPath: attempt.target!.projectPath, remote: 'destination' });
        if (controls.fetch === 'lost') throw new AgentCallError('unknown', 'Synthetic lost fetch.');
        if (controls.fetch === 'stale') throw new AgentCallError('not-dispatched', 'Synthetic replacement before fetch.', 'STALE_RESOURCE');
        transferred = true;
        return { ...scope, success: true, ref: request.ref, commit: request.commit };
      },
    } satisfies Awaited<ReturnType<ExecutionRuntimeApi['getGitService']>>;
    services.set(executorId, git); return git;
  };
  const resolve = async (executorId: string) => ({ getGitService: async () => service(executorId),
    getProjectService: options => runtime.getProjectService(options) } satisfies Pick<ExecutionRuntimeApi, 'getGitService' | 'getProjectService'>);
  return { ...f, attempt, source, controls, calls,
    prepare: () => prepareWorkflowInputs(f.resources, resolve, attempt, f.task, { executorId: 'local', instanceId: controls.instanceId,
      projectPath: attempt.target!.projectPath, git: service('local') }, effectFence()),
    intents: () => f.store.read(db => db.query<{ status: string; payload_json: string }, [string]>(
      "SELECT status,payload_json FROM operation_intents WHERE attempt_id=? AND kind='transfer' ORDER BY rowid").all(attempt.attemptId)),
    sourceSnapshot: () => f.store.read(db => ({ attempt: db.query('SELECT * FROM attempts WHERE id=?').get(source.input.attemptId),
      artifact: db.query('SELECT * FROM artifacts WHERE id=?').get(source.input.artifactId),
      claims: db.query('SELECT * FROM resource_claims WHERE attempt_id=?').all(source.input.attemptId) })) };
}

test.each(['local', 'clone', 'remote'] as const)('%s inputs follow approved coordinates, not an inspection-error fallback', async mode => {
  const f = await setup(mode); const before = f.sourceSnapshot();
  expect(await f.prepare()).toEqual({ kind: 'available' });
  expect(f.calls).toEqual(mode === 'local' ? ['inspect-destination'] : ['push', 'fetch', 'inspect-destination']);
  expect(f.sourceSnapshot()).toEqual(before);
  const intents = f.intents();
  if (mode === 'local') expect(intents).toHaveLength(0);
  else {
    expect(intents.map(intent => intent.status)).toEqual(['succeeded', 'succeeded']);
    const [push, fetch] = intents.map(intent => JSON.parse(intent.payload_json));
    expect(push.push.ref).toBe(fetch.fetch.ref);
    expect(push.input).toEqual(f.source.input);
    expect(fetch.input).toEqual(f.source.input);
    expect(f.store.read(db => db.query('SELECT executor_id FROM resource_claims WHERE attempt_id=? ORDER BY rowid').all(f.attempt.attemptId)))
      .toEqual([{ executor_id: f.source.managed.target.executorId }, { executor_id: 'local' }]);
  }
});

test.each(['lost', 'rejected', 'sha', 'runtime'] as const)('%s push never reaches fetch or changes source evidence', async outcome => {
  const f = await setup(); const before = f.sourceSnapshot(); f.controls.push = outcome;
  expect((await f.prepare()).kind).toBe(outcome === 'rejected' ? 'not-started' : 'unknown');
  expect(f.calls).toEqual(['push']);
  expect(f.intents().map(intent => intent.status)).toEqual([outcome === 'rejected' ? 'not-started' : 'unknown', 'planned']);
  expect(f.sourceSnapshot()).toEqual(before);
});

test('lost fetch retains the successful push and quarantines only the consumer', async () => {
  const f = await setup(); const before = f.sourceSnapshot(); f.controls.fetch = 'lost';
  expect((await f.prepare()).kind).toBe('unknown');
  expect(f.intents().map(intent => intent.status)).toEqual(['succeeded', 'unknown']);
  expect(f.sourceSnapshot()).toEqual(before);
  expect(f.store.read(db => db.query('SELECT quarantined FROM resource_claims WHERE attempt_id=?').all(f.attempt.attemptId)))
    .toEqual([{ quarantined: 1 }, { quarantined: 1 }]);
});

test('source replacement after inspection holds admission without spending a retry or mutating the source', async () => {
  const f = await setup('remote', 'planned'); const before = f.sourceSnapshot();
  f.controls.push = 'stale';
  const repositories = { async prepare() {
    const prepared = await f.prepare();
    if (prepared.kind === 'available') throw new Error('Synthetic source should reject dispatch.');
    return prepared;
  } } satisfies WorkflowRepositoryPort;
  const integration = { async prepare() { throw new Error('Integration must not start.'); },
    async inspect() { throw new Error('Integration must not be inspected.'); } } satisfies WorkflowIntegrationRepositoryPort;
  const admission = new WorkflowIntegrationAdmission(f.attempts, f.resources, repositories, integration, { now: () => '2026-01-01T00:00:00.000Z' });
  await admission.dispatch(f.attempt, effectFence());
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'not-started', admissionFailure: false });
  expect(f.service.detail(f.id).tasks.find(task => task.id === 'integrate')).toMatchObject({ hold: 'output-unknown' });
  expect(f.intents().map(intent => intent.status)).toEqual(['not-started', 'not-started']);
  expect(f.attempts.reserve(f.id, 'integrate')).toBeNull();
  expect(f.calls).toEqual(['push']); expect(f.sourceSnapshot()).toEqual(before);
});

test('unconfirmed stale push remains unknown rather than a definite held non-start', async () => {
  const f = await setup(); f.controls.push = 'stale-unknown';
  expect((await f.prepare()).kind).toBe('unknown');
  expect(f.intents().map(intent => intent.status)).toEqual(['unknown', 'planned']);
});

test('destination replacement leaves ordinary non-start with the earlier push retained', async () => {
  const f = await setup(); f.controls.fetch = 'stale';
  expect((await f.prepare()).kind).toBe('not-started');
  expect(f.intents().map(intent => intent.status)).toEqual(['succeeded', 'not-started']);
});

test('inspection failure never grants remote-write permission', async () => {
  const f = await setup(); f.controls.inspectionError = true;
  await expect(f.prepare()).rejects.toThrow('inspection');
  expect(f.calls).toEqual([]); expect(f.intents()).toHaveLength(0);
});

test('missing same-clone object is not an invitation to fetch', async () => {
  const f = await setup('local'); f.controls.destinationError = true;
  await expect(f.prepare()).rejects.toThrow('missing object');
  expect(f.calls).toEqual(['inspect-destination']); expect(f.intents()).toHaveLength(0);
});

test('same-clone reuse survives a producer runtime restart without reattributing source evidence', async () => {
  const f = await setup('local'); const before = f.sourceSnapshot();
  f.controls.instanceId = 'replacement-runtime'; f.controls.inspectionError = true;
  expect(await f.prepare()).toEqual({ kind: 'available' });
  expect(f.calls).toEqual(['inspect-destination']);
  expect(f.sourceSnapshot()).toEqual(before); expect(f.intents()).toHaveLength(0);
});

test.each(['restart', 'dirty'] as const)('cross-clone source %s requires resolution before effects', async kind => {
  const f = await setup(); const before = f.sourceSnapshot();
  if (kind === 'restart') f.controls.instanceId = 'replacement-runtime';
  else f.controls.dirty = true;
  expect(await f.prepare()).toMatchObject({ kind: 'held' });
  expect(f.calls).toEqual([]); expect(f.intents()).toHaveLength(0);
  expect(f.sourceSnapshot()).toEqual(before);
});

test('pause between push and fetch blocks the next mutation, retaining the pushed ref', async () => {
  const f = await setup(); f.controls.afterPush = () => { f.write({ action: 'pause', workflowId: f.id }); };
  await expect(f.prepare()).rejects.toThrow('admission');
  f.resources.interruptPreparation(f.attempt.attemptId);
  expect(f.calls).toEqual(['push']);
  expect(f.intents().map(intent => intent.status)).toEqual(['succeeded', 'not-started']);
});

test('failed post-transfer ancestry prevents managed creation', async () => {
  const f = await setup(); f.controls.lineage = false;
  await expect(f.prepare()).rejects.toThrow('lineage');
  expect(f.calls).toEqual(['push', 'fetch', 'inspect-destination']);
  expect(f.intents().map(intent => intent.status)).toEqual(['succeeded', 'succeeded']);
});

test('metadata preflight fails before any remote write', async () => {
  const f = await setup();
  f.store.transaction(db => db.query("UPDATE operation_intents SET result_json=? WHERE attempt_id=? AND kind='worktree'")
    .run('x'.repeat(WORKFLOW_LIMITS.workflowResourceBytes - 1024), f.source.input.attemptId));
  await expect(f.prepare()).rejects.toThrow('metadata');
  expect(f.calls).toEqual([]); expect(f.intents()).toHaveLength(0);
});

test.each(['artifact-attempt', 'runtime', 'worktree', 'remote', 'held', 'multiple', 'missing'] as const)('source resolution rejects %s mismatches', async kind => {
  const f = await setup();
  f.store.transaction(db => {
    const artifact = f.service.detail(f.id).artifacts[0]!;
    if (kind === 'held') { db.query("UPDATE tasks SET hold='intervention' WHERE workflow_id=? AND id='source0'").run(f.id); return; }
    if (kind === 'missing') { db.query('DELETE FROM artifacts WHERE id=?').run(artifact.id); return; }
    if (kind === 'multiple') { db.query('INSERT INTO artifacts VALUES (?,?,?)').run('other', artifact.attempt.attemptId, JSON.stringify(artifact)); return; }
    if (kind === 'remote') {
      const target = { ...f.source.managed, target: { ...f.source.managed.target, remote: { name: 'other', url: 'https://example.invalid/other.git' } } };
      db.query('UPDATE attempts SET managed_target_json=? WHERE id=?').run(JSON.stringify(target), f.source.input.attemptId); return;
    }
    const { digest: _digest, ...content } = artifact;
    const changed = { ...content, attempt: { ...content.attempt, ...(kind === 'artifact-attempt' ? { attemptId: 'other' } : {}) },
      git: { ...content.git!, ...(kind === 'runtime' ? { runtimeInstanceId: 'other' } : kind === 'worktree' ? { worktreeIdentity: 'other' } : {}) } };
    db.query('UPDATE artifacts SET payload_json=? WHERE id=?').run(JSON.stringify({ ...changed, digest: workflowDigest(changed) }), artifact.id);
  });
  await expect(f.prepare()).rejects.toThrow();
  expect(f.calls).toEqual([]); expect(f.intents()).toHaveLength(0);
});
