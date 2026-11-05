import { afterEach, expect, test } from 'bun:test';
import type { WorkflowPlan, WorkflowPlanTask } from '../../../../common/workflows.js';
import type { GhPublishedPullRequest } from '../../../../common/gh.js';
import { WorkflowApprovals } from '../approvals.js';
import { WorkflowPublicationAdmission } from '../publication-admission.js';
import type { WorkflowPublication, WorkflowPublicationPort } from '../publication-contracts.js';
import { browser, effectFence, prepareManagedTarget } from './fixture.js';
import { WorkflowService } from '../service.js';
import { WorkflowStore } from '../store.js';
import { recheckPublication } from '../publication-recovery.js';
import { workflowDigest } from '../inputs.js';
import { integrationFixture, integrationPlan, now, observedRepository, replaceTarget } from './integration-fixture.js';

const fixtures: ReturnType<typeof integrationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

async function setup() {
  const source = replaceTarget(integrationPlan(1).tasks[0]!, { remote: { name: 'origin', url: 'https://github.com/synthetic/repo.git' } });
  if (!('target' in source.spec)) throw new Error('Synthetic target.');
  const gate: WorkflowPlanTask = { ...source, id: 'gate', dependsOn: [source.id], acceptance: [],
    spec: { kind: 'approval', purpose: 'publication', requirements: [source.id] } };
  const publish: WorkflowPlanTask = { ...source, id: 'publish', dependsOn: [source.id, gate.id], acceptance: [],
    spec: { kind: 'publish-pr', target: source.spec.target, sourceTaskId: source.id, approvalTaskId: gate.id,
      headBranch: 'garcon/delivery', baseBranch: 'main', title: 'Synthetic delivery', body: 'Synthetic description', draft: true } };
  const input: WorkflowPlan = { ...integrationPlan(1), policy: { concurrency: 2, allowRemoteWrites: true },
    goal: { kind: 'pr-open', taskIds: [publish.id] }, tasks: [source, gate, publish] };
  const f = integrationFixture(input); fixtures.push(f); await f.produce();
  const calls = { push: 0, create: 0, find: 0, verify: 0 };
  const controls = { push: 'observed' as 'observed' | 'unknown' | 'not-started', create: 'observed' as 'observed' | 'unknown' | 'not-started',
    lookup: 'empty' as 'empty' | 'exact' | 'duplicate' | 'changed', afterPush: () => {}, afterCreate: () => {}, verify: () => {} };
  let captured: WorkflowPublication;
  const pull = (): GhPublishedPullRequest => ({ ...captured, number: 1, url: 'https://github.com/synthetic/repo/pull/1', state: 'open' });
  const port: WorkflowPublicationPort = {
    async inspectTarget(spec) { return { executorId: spec.target.executorId, instanceId: 'synthetic-runtime',
      repository: { host: 'github.com', nameWithOwner: 'synthetic/repo' }, actor: { id: 'synthetic-actor', login: 'synthetic' }, baseCommit: spec.target.baseCommit }; },
    async prepare(value) { captured = value; return {
      async verify() { calls.verify++; controls.verify(); },
      async push() { calls.push++; controls.afterPush(); return controls.push === 'observed' ? { kind: 'observed', value: undefined }
        : { kind: controls.push, detail: 'Synthetic push rejection.' }; },
      async create() { calls.create++; controls.afterCreate(); return controls.create === 'observed' ? { kind: 'observed', value: pull() }
        : { kind: controls.create, detail: 'Synthetic create uncertainty.' }; },
    }; },
    async find(value) { calls.find++; return { executorId: value.executorId, instanceId: value.runtimeInstanceId, repository: value.repository,
      actor: value.actor, pulls: controls.lookup === 'empty' ? [] : controls.lookup === 'duplicate' ? [pull(), pull()]
        : controls.lookup === 'changed' ? [{ ...pull(), headCommit: 'f'.repeat(40) }] : [pull()] }; },
  };
  const approvals = new WorkflowApprovals(f.store, { now, onInvalidated() {} });
  await approvals.preparePublication(f.id, port, new AbortController().signal);
  const approval = f.service.detail(f.id).gates[0]!;
  f.write({ action: 'approve', workflowId: f.id, gateId: gate.id, manifestDigest: approval.digest, decision: 'approve' });
  const admission = new WorkflowPublicationAdmission(f.attempts, f.resources, {
    async prepare(attempt) { return { kind: 'prepared', resource: prepareManagedTarget(f.resources, attempt) }; },
    async inspect(resource) { return observedRepository(resource, resource.head); },
  }, port, { now, wait: async () => {} });
  const attempt = f.attempts.reserve(f.id, publish.id)!;
  return { ...f, calls, controls, approval, attempt, admission, port, run: () => admission.dispatch(attempt, effectFence()) };
}

test('publication approval binds exact inputs, actor, body and marker; one PR settles without a chat', async () => {
  const f = await setup();
  expect(f.approval.manifest.publication?.body).toContain('<!-- garcon-workflow-publication:');
  const inspection = f.service.inspectGate(f.id, 'gate');
  expect(inspection.digest).toBe(f.approval.digest);
  expect(inspection.evidence).toMatchObject([{ provenance: 'runtime-observed', outcome: 'pass', summaryTruncated: false }]);
  await f.run(); await f.run();
  expect(f.calls).toEqual({ push: 1, create: 1, find: 0, verify: 2 });
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'succeeded', chatId: null, effectiveInput: null });
  expect(f.service.artifacts(f.id).filter(a => a.kind === 'pull-request')).toMatchObject([{ outcome: 'pass', provenance: 'runtime-observed',
    url: 'https://github.com/synthetic/repo/pull/1', git: { scope: 'managed-publication' } }]);
});

test.each(['empty', 'exact', 'duplicate', 'changed'] as const)('lost creation reply reconciles %s without a second write', async lookup => {
  const f = await setup(); f.controls.create = 'unknown'; f.controls.lookup = lookup; await f.run();
  expect(f.calls.create).toBe(1); expect(f.calls.push).toBe(1);
  expect(f.calls.find).toBe(lookup === 'empty' ? 5 : 1);
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe(lookup === 'exact' ? 'succeeded' : 'unknown');
  expect(f.attempts.reserve(f.id, 'publish')).toBeNull();
});

test.each(['unknown', 'not-started'] as const)('push %s never creates or repeats', async kind => {
  const f = await setup(); f.controls.push = kind; await f.run();
  expect(f.calls.create).toBe(0); expect(f.calls.push).toBe(1);
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe(kind);
  expect(f.attempts.reserve(f.id, 'publish')).toBeNull();
});

test('pause after push blocks creation and retains the ref', async () => {
  const f = await setup(); f.controls.afterPush = () => { f.write({ action: 'pause', workflowId: f.id }); }; await f.run();
  expect(f.calls.create).toBe(0);
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('not-started');
  expect(f.store.read(db => db.query("SELECT COUNT(*) AS n FROM operation_intents WHERE attempt_id=? AND kind='publication' AND status='succeeded'")
    .get(f.attempt.attemptId))).toEqual({ n: 1 });
});

test('pause after create drains evidence but Stop revokes attribution', async () => {
  for (const action of ['pause', 'stop'] as const) {
    const f = await setup(); f.controls.afterCreate = () => { f.write({ action, workflowId: f.id }); }; await f.run();
    expect(f.calls.create).toBe(1);
    expect(f.attempts.get(f.attempt.attemptId).resolution).toBe(action === 'pause' ? 'succeeded' : 'unknown');
    expect(f.service.artifacts(f.id).filter(a => a.kind === 'pull-request')).toHaveLength(action === 'pause' ? 1 : 0);
  }
});

test('changed publication actor or base before push produces no external effects', async () => {
  const f = await setup(); f.controls.verify = () => { throw new Error('Synthetic drift.'); }; await f.run();
  expect(f.calls.push).toBe(0); expect(f.calls.create).toBe(0);
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'not-started', admissionFailure: false });
});

test.each(['empty', 'exact', 'duplicate', 'changed'] as const)('browser publication recheck on a replacement runtime: %s', async lookup => {
  const f = await setup(); f.controls.create = 'unknown'; await f.run();
  const before = f.attempts.get(f.attempt.attemptId);
  const originalCreate = f.resources.get(f.approval.manifest.publication!.operationId);
  f.controls.lookup = lookup;
  const find: typeof f.port.find = async (publication, signal) => ({ ...await f.port.find(publication, signal), instanceId: 'replacement-runtime' });
  const service = new WorkflowService(f.store, { enabled: () => false, now,
    recheckPublication: (id, signal) => recheckPublication(f.store, id, signal, (saved, signal) => find(saved.publication, signal),
      { now, onInvalidated() {}, wait: async () => {} }),
    async observeAdoption(capture, signal) {
      if (capture.kind !== 'publication') throw new Error('Expected publication recovery.');
      return { kind: 'publication', lookup: await find(capture.saved.publication, signal), assertCurrent() {} };
    },
  });
  const request = { expectedStoreId: service.bootstrap().storeId, operationId: crypto.randomUUID(),
    mutation: { action: 'recheck-publication' as const, workflowId: f.id, attemptId: f.attempt.attemptId,
      publicationOperationId: f.approval.manifest.publication!.operationId } };
  const result = await service.executeHttp(request, browser);
  const calls = f.calls.find;
  expect(await service.executeHttp(request, browser)).toEqual(result);
  expect(f.calls.find).toBe(calls);
  expect(calls).toBe(lookup === 'empty' ? 10 : 6);
  expect(f.attempts.get(before.attemptId)).toEqual(before);
  expect(f.resources.get(originalCreate.id)).toEqual(originalCreate);
  expect(f.calls.push).toBe(1); expect(f.calls.create).toBe(1);
  const adopt = () => service.executeHttp({ ...request, operationId: crypto.randomUUID(), mutation: { action: 'resolve', workflowId: f.id,
    taskId: before.taskId, generation: before.generation, attemptId: before.attemptId, resolution: 'adopt', commit: null,
    releaseRisk: false, evidence: 'Operator inspected the original exact PR.' } }, browser);
  if (lookup === 'exact') {
    await adopt();
    expect(f.attempts.get(before.attemptId)).toMatchObject({ resolution: 'succeeded', result: before.result });
    expect(service.detail(f.id).outcome).toBe('succeeded');
    expect(service.artifacts(f.id).find(artifact => artifact.kind === 'pull-request')).toMatchObject({ provenance: 'operator-attested', git: null });
  } else {
    await expect(adopt()).rejects.toThrow('Exactly one');
    expect(service.detail(f.id).outcome).toBe('needs-attention');
  }
});

test('a recheck reconciles the historical intent after replanning without clearing current holds', async () => {
  const f = await setup(); f.controls.create = 'unknown'; await f.run(); f.controls.lookup = 'exact';
  f.write({ action: 'plan', workflowId: f.id, expectedPlanRevision: 1, plan: { ...f.input, tasks: f.input.tasks.map(task => task.id === 'publish'
    && task.spec.kind === 'publish-pr' ? { ...task, spec: { ...task.spec, headBranch: 'garcon/replacement' } } : task) } });
  f.activate(f.id);
  const before = workflowDigest(f.attempts.get(f.attempt.attemptId));
  const service = new WorkflowService(f.store, { enabled: () => true, now,
    recheckPublication: (id, signal) => recheckPublication(f.store, id, signal, (saved, signal) => f.port.find(saved.publication, signal),
      { now, onInvalidated() {}, wait: async () => {} }) });
  await service.executeHttp({ expectedStoreId: service.bootstrap().storeId, operationId: crypto.randomUUID(), mutation: {
    action: 'recheck-publication', workflowId: f.id, attemptId: f.attempt.attemptId,
    publicationOperationId: f.approval.manifest.publication!.operationId } }, browser);
  expect(workflowDigest(f.attempts.get(f.attempt.attemptId))).toBe(before);
  expect(f.resources.get(f.approval.manifest.publication!.operationId).status).toBe('unknown');
  expect(f.calls.push).toBe(1); expect(f.calls.create).toBe(1);
});

test('historical inspection retains removed publication tasks and exact recovery identities', async () => {
  const f = await setup(); f.controls.create = 'unknown'; await f.run();
  f.write({ action: 'plan', workflowId: f.id, expectedPlanRevision: 1, plan: { ...f.input,
    goal: { kind: 'artifacts', taskIds: ['source0'] }, tasks: [f.input.tasks[0]!] } });
  f.activate(f.id);
  expect(f.service.detail(f.id).tasks.some(task => task.id === 'publish')).toBe(false);
  const inspection = f.service.inspectAttempt(f.id, f.attempt.attemptId);
  expect(inspection.task.spec.kind).toBe('publish-pr');
  expect(inspection.operations).toContainEqual(expect.objectContaining({ id: f.approval.manifest.publication!.operationId,
    stage: 'create', status: 'unknown' }));
  expect(inspection.resources.some(claim => claim.quarantined)).toBe(true);
  expect(() => f.service.inspectAttempt('different-workflow', f.attempt.attemptId)).toThrow('another workflow');
});

test('publication adoption preserves a succeeded create reply when later attribution is revoked', async () => {
  const f = await setup();
  f.controls.afterCreate = () => { f.write({ action: 'stop', workflowId: f.id }); };
  await f.run();
  const operationId = f.approval.manifest.publication!.operationId;
  const original = f.resources.get(operationId);
  expect(original.status).toBe('succeeded');
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('unknown');
  f.controls.lookup = 'exact';
  const service = new WorkflowService(f.store, { enabled: () => true, now, observeAdoption: async (capture, signal) => {
    if (capture.kind !== 'publication') throw new Error('Synthetic publication expected');
    return { kind: 'publication', lookup: await f.port.find(capture.saved.publication, signal), assertCurrent() {} };
  } });
  await service.executeHttp({ expectedStoreId: service.bootstrap().storeId, operationId: crypto.randomUUID(), mutation: {
    action: 'resolve', workflowId: f.id, taskId: f.attempt.taskId, generation: f.attempt.generation,
    attemptId: f.attempt.attemptId, resolution: 'adopt', commit: null, releaseRisk: false, evidence: 'Independently observed exact PR' } }, browser);
  expect(f.resources.get(operationId)).toEqual(original);
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('succeeded');
});

test('interrupted recheck retains its consumed read budget across reopen and same-ID replay performs no reads', async () => {
  const f = await setup(); f.controls.create = 'unknown'; await f.run();
  const abort = new AbortController();
  const service = new WorkflowService(f.store, { enabled: () => false, now,
    recheckPublication: (id, signal) => recheckPublication(f.store, id, signal, async (saved, signal) => {
      const result = await f.port.find(saved.publication, signal); abort.abort(); return result;
    }, { now, onInvalidated() {}, wait: async () => {} }) });
  const request = { expectedStoreId: service.bootstrap().storeId, operationId: crypto.randomUUID(), mutation: {
    action: 'recheck-publication' as const, workflowId: f.id, attemptId: f.attempt.attemptId,
    publicationOperationId: f.approval.manifest.publication!.operationId } };
  const receipt = await service.executeHttp(request, browser, abort.signal);
  expect(f.resources.get(request.operationId).reconcileCount).toBe(1);
  const reads = f.calls.find;
  f.store.close();
  const reopened = new WorkflowStore(f.directory);
  try {
    const recovered = new WorkflowService(reopened, { enabled: () => false, now, async recheckPublication() { throw new Error('Must not restart reads'); } });
    expect(await recovered.executeHttp(request, browser)).toEqual(receipt);
    expect(f.calls.find).toBe(reads);
    expect(reopened.read(db => db.query('SELECT reconcile_count AS count FROM operation_intents WHERE id=?').get(request.operationId))).toEqual({ count: 1 });
  } finally { reopened.close(); }
});
