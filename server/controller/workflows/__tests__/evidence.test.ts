import { afterEach, expect, test } from 'bun:test';
import type { AutomationResult } from '../../../../common/automation.js';
import type { WorkflowPlan, WorkflowPlanTask } from '../../../../common/workflows.js';
import { WorkflowAttempts } from '../attempts.js';
import type { WorkflowOutputFence, WorkflowRepositoryObservation } from '../contracts.js';
import { WorkflowEvidence } from '../evidence.js';
import { workflowDigest, workflowEffectiveInput, workflowStartInput } from '../inputs.js';
import { suspendWorkflowAdmission } from '../recovery.js';
import { WorkflowResources } from '../resources.js';
import { workflowTerminalObservation } from '../terminal-observation.js';
import { effectFence, fixture, plan, prepareManagedTarget } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const now = () => '2026-01-01T00:00:00.000Z';

function agentTask(outputs: ('commit' | 'summary' | 'review')[]): WorkflowPlanTask {
  const command = plan().tasks[0]!;
  if (command.spec.kind !== 'command') throw new Error('Synthetic fixture requires a command.');
  return { ...command, spec: { kind: 'agent', target: command.spec.target, prompt: 'Synthetic work.', outputs,
    selection: { agentId: 'codex', model: 'synthetic', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
      providerRevision: null, permissionMode: 'default', thinkingMode: 'none', preambles: [],
      agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} } } } };
}

function setup(task = plan().tasks[0]!, input: WorkflowPlan = { ...plan(), tasks: [task] }) {
  const f = fixture(); fixtures.push(f);
  const id = f.write({ action: 'create', captainChatId: null, plan: input }).workflowId;
  f.activate(id);
  const attempts = new WorkflowAttempts(f.store, { now });
  const resources = new WorkflowResources(f.store, now);
  let attempt = attempts.reserve(id, task.id)!;
  attempts.beginPreparation(attempt.attemptId);
  attempt = attempts.bindTarget(attempt.attemptId, prepareManagedTarget(resources, attempt));
  const managed = attempt.managedTarget!;
  attempt = attempts.bindPrepared(attempt.attemptId, { serverInstanceId: 'synthetic-controller',
    chatId: '1234567890123456', turnId: 'synthetic-turn', clientRequestId: attempt.requestId },
  workflowEffectiveInput(workflowStartInput(attempt, task)));
  attempt = attempts.markDispatching(attempt.attemptId, effectFence());
  const terminal: AutomationResult = { kind: 'completed', receivedOutputCoverage: 'complete',
    executionScope: { executorId: managed.target.executorId, instanceId: managed.instanceId },
    commandOutcome: task.spec.kind === 'command' ? { outcome: 'finished', exitCode: 0, signal: null,
      cwd: { kind: 'reported', path: managed.target.projectPath }, capture: 'complete' } : null,
    receipt: { state: 'completed', chatId: attempt.chatId!, turnId: attempt.turnId!, clientRequestId: attempt.requestId,
      acceptedAt: now(), updatedAt: now(), settledAt: now(),
      output: { availability: 'available', completeness: 'complete', text: 'Synthetic summary.' } } };
  const observed: WorkflowRepositoryObservation = { executorId: managed.target.executorId, instanceId: managed.instanceId,
    managed: { managedResourceId: managed.managedResourceId, operationId: managed.operationId,
      repositoryIdentity: managed.repositoryIdentity, worktreeIdentity: managed.worktreeIdentity,
      worktreePath: managed.target.projectPath, branch: managed.branch, baseCommit: managed.head, head: managed.head, dirty: false },
    commit: { commit: managed.head, tree: managed.baseTree, parents: [], containsAncestor: true } };
  if (task.spec.kind === 'agent' && task.spec.outputs.includes('commit')) {
    Object.assign(observed.managed, { head: 'd'.repeat(40) });
    Object.assign(observed.commit, { commit: 'd'.repeat(40), tree: 'e'.repeat(40) });
  }
  const control = { revoked: false, gapped: false };
  const shutdown = new AbortController();
  const signal = new AbortController();
  const fence: WorkflowOutputFence = { ...effectFence(), shutdown: shutdown.signal,
    get revoked() { return control.revoked; }, get outputGapped() { return control.gapped; } };
  const evidence = new WorkflowEvidence(f.store, { inspect: async () => observed }, { now });
  function capture(result: AutomationResult = terminal) {
    attempt = attempts.observe(attempt.attemptId, { ...workflowTerminalObservation(task, result), retainControl: true }, fence);
    return evidence.capture(attempt, task, result, fence, signal.signal);
  }
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, id, task, attempts,
    attempt: () => attempts.get(attempt.attemptId), terminal, observed, control, shutdown, signal, capture,
    artifacts: () => f.service.detail(id).artifacts,
    claims: () => f.store.read(db => db.query('SELECT * FROM resource_claims WHERE attempt_id=?').all(attempt.attemptId)) };
}

test('command acceptance commits evidence, resolution, control and claims atomically', async () => {
  const f = setup();
  (await f.capture()).commit();
  expect(f.attempt()).toMatchObject({ resolution: 'succeeded', controlState: 'released', dispatchPhase: 'settled',
    result: { outputCaptured: true } });
  expect(f.artifacts()).toMatchObject([{ kind: 'command', outcome: 'pass', provenance: 'runtime-observed',
    git: { runtimeInstanceId: 'synthetic-runtime', projectPath: f.attempt().target!.projectPath } }]);
  expect(f.claims()).toMatchObject([{ retained: 1, quarantined: 0 }]);
});

test.each(['pause', 'disable'] as const)('accepted work drains after %s without authorizing another attempt', async change => {
  const f = setup();
  const captured = await f.capture();
  if (change === 'pause') f.write({ action: 'pause', workflowId: f.id });
  else suspendWorkflowAdmission(f.store);
  captured.commit();
  expect(f.attempt().resolution).toBe('succeeded');
  expect(f.attempts.reserve(f.id, f.task.id)).toBeNull();
});

test.each(['revoked', 'released', 'generation', 'held', 'shutdown', 'signal', 'canceled', 'operation'] as const)(
  '%s between capture and commit cannot accept evidence', async change => {
    const f = setup(); const captured = await f.capture();
    if (change === 'revoked') f.control.revoked = true;
    if (change === 'shutdown') f.shutdown.abort();
    if (change === 'signal') f.signal.abort();
    if (change === 'canceled') f.write({ action: 'cancel', workflowId: f.id });
    if (change === 'released') f.store.transaction(db => db.query("UPDATE attempts SET control_state='released' WHERE id=?").run(f.attempt().attemptId));
    if (change === 'generation') f.store.transaction(db => db.query('UPDATE tasks SET generation=generation+1 WHERE workflow_id=?').run(f.id));
    if (change === 'held') f.store.transaction(db => db.query("UPDATE tasks SET hold='intervention' WHERE workflow_id=?").run(f.id));
    if (change === 'operation') f.store.transaction(db => db.query("UPDATE operation_intents SET status='unknown' WHERE attempt_id=?").run(f.attempt().attemptId));
    expect(() => captured.commit()).toThrow();
    expect(f.artifacts()).toHaveLength(0);
    expect(f.attempt().resolution).not.toBe('succeeded');
  },
);

test('storage failure rolls back evidence and settlement together', async () => {
  const f = setup(); const captured = await f.capture();
  f.controls.failCommit = true;
  expect(() => captured.commit()).toThrow(expect.objectContaining({ code: 'WORKFLOW_UNAVAILABLE' }));
  f.reopen();
  expect(f.service.detail(f.id).artifacts).toHaveLength(0);
  expect(f.service.attempts(f.id)[0]).toMatchObject({ resolution: 'open', controlState: 'leased', result: { outputCaptured: false } });
});

test('expected nonzero exit can pass despite a failed turn receipt', async () => {
  const task = plan().tasks[0]!;
  if (task.spec.kind !== 'command') throw new Error('Synthetic task kind.');
  const f = setup({ ...task, spec: { ...task.spec, expectedExitCode: 7 } });
  const result: AutomationResult = { kind: 'failed', certainty: 'definite', receipt: null, detail: 'Synthetic exit.',
    executionScope: f.terminal.executionScope,
    receivedOutputCoverage: 'complete', commandOutcome: { ...f.terminal.commandOutcome!, outcome: 'failed', exitCode: 7 } };
  (await f.capture(result)).commit();
  expect(f.attempt().resolution).toBe('succeeded');
  expect(f.artifacts()[0]?.commandOutcome?.exitCode).toBe(7);
});

test('a definite wrong exit records failure and the approved retry deadline', async () => {
  const f = setup();
  (await f.capture({ ...f.terminal, commandOutcome: { ...f.terminal.commandOutcome!, outcome: 'failed', exitCode: 7 } })).commit();
  expect(f.attempt().resolution).toBe('failed');
  expect(f.artifacts()[0]).toMatchObject({ outcome: 'fail', commandOutcome: { exitCode: 7 } });
  expect(f.service.detail(f.id).tasks[0]?.nextEligibleAt).toBe('2026-01-01T00:00:01.000Z');
});

test.each(['dirty', 'head', 'tree', 'lineage', 'worktree', 'runtime', 'executor', 'cwd', 'truncated', 'gapped',
  'execution-scope', 'execution-instance', 'execution-executor'] as const)(
  '%s cannot certify an unchanged clean command input', async change => {
    const f = setup();
    if (change === 'dirty') Object.assign(f.observed.managed, { dirty: true });
    if (change === 'head') {
      Object.assign(f.observed.managed, { head: 'b'.repeat(40) });
      Object.assign(f.observed.commit, { commit: 'b'.repeat(40) });
    }
    if (change === 'tree') Object.assign(f.observed.commit, { tree: 'b'.repeat(40) });
    if (change === 'lineage') Object.assign(f.observed.commit, { containsAncestor: false });
    if (change === 'worktree') Object.assign(f.observed.managed, { worktreeIdentity: 'changed' });
    if (change === 'runtime') Object.assign(f.observed, { instanceId: 'changed' });
    if (change === 'executor') Object.assign(f.observed, { executorId: 'changed' });
    if (change === 'cwd') Object.assign(f.terminal.commandOutcome!, { cwd: { kind: 'reported', path: '/synthetic/other' } });
    if (change === 'truncated') Object.assign(f.terminal.commandOutcome!, { capture: 'truncated' });
    if (change === 'execution-scope') Object.assign(f.terminal, { executionScope: null });
    if (change === 'execution-instance') Object.assign(f.terminal.executionScope!, { instanceId: 'different-runtime' });
    if (change === 'execution-executor') Object.assign(f.terminal.executionScope!, { executorId: 'different-executor' });
    const captured = await f.capture();
    if (change === 'gapped') f.control.gapped = true;
    captured.commit();
    expect(f.attempt().resolution).toBe('unknown');
    expect(f.artifacts()[0]?.outcome).toBe('unknown');
    expect(f.claims()).toMatchObject([{ retained: 0, quarantined: 1 }]);
  },
);

test.each(['incomplete-log', 'signal'] as const)('a definite %s failure is retained rather than relabeled unknown', async change => {
  const f = setup();
  const captured = await f.capture({ ...f.terminal, commandOutcome: { ...f.terminal.commandOutcome!, outcome: 'failed',
    exitCode: change === 'signal' ? null : 7, signal: change === 'signal' ? 'SIGTERM' : null, capture: 'incomplete' } });
  f.control.gapped = true;
  captured.commit();
  expect(f.attempt()).toMatchObject({ resolution: 'failed', result: { outputCaptured: true, receivedOutputCoverage: 'gapped' } });
  expect(f.artifacts()[0]?.outcome).toBe('fail');
  f.reopen();
  expect(f.service.attempts(f.id)[0]).toMatchObject({ resolution: 'failed', controlState: 'released', dispatchPhase: 'settled' });
});

test('exit-status-only evidence preserves disclosure of incomplete logs', async () => {
  const task = plan().tasks[0]!;
  if (task.spec.kind !== 'command') throw new Error('Synthetic task kind.');
  const f = setup({ ...task, spec: { ...task.spec, outputRequirement: 'exit-status-only' } });
  const captured = await f.capture({ ...f.terminal, commandOutcome: { ...f.terminal.commandOutcome!, capture: 'truncated' } });
  f.control.gapped = true;
  captured.commit();
  expect(f.attempt()).toMatchObject({ resolution: 'succeeded', result: { receivedOutputCoverage: 'gapped' } });
  expect(f.artifacts()[0]).toMatchObject({ receivedOutputCoverage: 'gapped', commandOutcome: { capture: 'truncated' } });
});

test('a SHA in agent prose never substitutes for the runtime-observed commit', async () => {
  const f = setup(agentTask(['commit', 'summary']));
  if (f.terminal.kind !== 'completed') throw new Error('Synthetic result kind.');
  f.terminal.receipt.output = { availability: 'available', completeness: 'complete', text: `Synthetic claimed commit ${'b'.repeat(40)}.` };
  (await f.capture()).commit();
  expect(f.artifacts().find(artifact => artifact.kind === 'commit')).toMatchObject({ commit: f.observed.managed.head, provenance: 'runtime-observed' });
  expect(f.artifacts().find(artifact => artifact.kind === 'summary')).toMatchObject({ provenance: 'agent-asserted', commit: null });
});

test.each(['summary', 'review'] as const)('unknown %s output never becomes runtime-observed', async kind => {
  const f = setup(agentTask([kind]));
  const captured = await f.capture();
  f.control.gapped = true;
  captured.commit();
  expect(f.artifacts()[0]).toMatchObject({ kind, provenance: 'agent-asserted', outcome: 'unknown' });
});

test('a completed agent that produces no commit records a definite failure', async () => {
  const f = setup(agentTask(['commit']));
  Object.assign(f.observed.managed, { head: f.attempt().managedTarget!.head });
  Object.assign(f.observed.commit, { commit: f.observed.managed.head, tree: f.attempt().managedTarget!.baseTree });
  (await f.capture()).commit();
  expect(f.attempt().resolution).toBe('failed');
  expect(f.artifacts()[0]).toMatchObject({ kind: 'commit', outcome: 'fail' });
});

test.each(['accept', 'reject', 'wrong-commit', 'prose', 'extra-field', 'changed-input'] as const)(
  'structured review %s stays an exact-input agent assertion', async decision => {
    const f = setup(agentTask(['review']));
    if (f.terminal.kind !== 'completed') throw new Error('Synthetic result kind.');
    const review = { commit: decision === 'wrong-commit' ? 'b'.repeat(40) : f.observed.managed.head,
      decision: decision === 'reject' ? 'reject' : 'accept', summary: 'Synthetic review.' };
    f.terminal.receipt.output = { availability: 'available', completeness: 'complete',
      text: decision === 'prose' ? 'Approved.' : JSON.stringify(decision === 'extra-field' ? { ...review, authorize: true } : review) };
    if (decision === 'changed-input') {
      Object.assign(f.observed.managed, { head: 'b'.repeat(40) }); Object.assign(f.observed.commit, { commit: 'b'.repeat(40) });
    }
    (await f.capture()).commit();
    expect(f.artifacts()[0]).toMatchObject({ kind: 'review', provenance: 'agent-asserted',
      outcome: decision === 'accept' ? 'pass' : decision === 'reject' ? 'fail' : 'unknown' });
  },
);

test('a second commit cannot duplicate artifacts or alter accepted evidence', async () => {
  const f = setup(); const captured = await f.capture(); captured.commit();
  expect(() => captured.commit()).toThrow();
  expect(f.artifacts()).toHaveLength(1);
});

test.each(['matching', 'mismatched', 'changed-during-capture', 'advanced-summary'] as const)('independent review gates execution and final acceptance: %s', async kind => {
  const reviewer = { ...agentTask(['review']), id: 'reviewer' };
  const check = { ...(kind === 'advanced-summary' ? agentTask(['summary']) : plan().tasks[0]!), dependsOn: [reviewer.id],
    acceptance: [{ kind: 'independent-review' as const, taskId: reviewer.id }] };
  const f = setup(reviewer, { ...plan(), tasks: [reviewer, check] });
  if (f.terminal.kind !== 'completed') throw new Error('Synthetic terminal kind.');
  f.terminal.receipt.output = { availability: 'available', completeness: 'complete',
    text: JSON.stringify({ commit: f.observed.managed.head, decision: 'accept', summary: 'Synthetic review.' }) };
  (await f.capture()).commit();
  const changeReview = () => f.store.transaction(db => {
    const original = f.artifacts()[0]!;
    const changed = { ...original, commit: 'f'.repeat(40) };
    db.query('UPDATE artifacts SET payload_json=? WHERE id=?').run(JSON.stringify({ ...changed, digest: workflowDigest(changed) }), original.id);
  });
  if (kind === 'mismatched') changeReview();
  const reserved = f.attempts.reserve(f.id, check.id)!;
  if (kind === 'mismatched') {
    expect(() => f.attempts.beginPreparation(reserved.attemptId)).toThrow('exact commit');
    expect(f.store.read(db => db.query('SELECT 1 FROM operation_intents WHERE attempt_id=?').all(reserved.attemptId))).toHaveLength(0);
    return;
  }
  f.attempts.beginPreparation(reserved.attemptId);
  const resources = new WorkflowResources(f.store, now);
  const managed = prepareManagedTarget(resources, reserved);
  f.attempts.bindTarget(reserved.attemptId, managed);
  const key = { serverInstanceId: 'synthetic-controller', chatId: '2234567890123456', turnId: 'synthetic-check-turn', clientRequestId: reserved.requestId };
  let attempt = f.attempts.bindPrepared(reserved.attemptId, key, workflowEffectiveInput(workflowStartInput(f.attempts.get(reserved.attemptId), check)));
  f.attempts.markDispatching(attempt.attemptId, effectFence());
  const terminal: AutomationResult = { ...f.terminal, receipt: { ...f.terminal.receipt, ...key },
    commandOutcome: { outcome: 'finished', exitCode: 0, signal: null, capture: 'complete', cwd: { kind: 'reported', path: managed.target.projectPath } } };
  attempt = f.attempts.observe(attempt.attemptId, { ...workflowTerminalObservation(check, terminal), retainControl: true }, effectFence());
  const observed = { ...f.observed, managed: { ...f.observed.managed, operationId: managed.operationId,
    managedResourceId: managed.managedResourceId, worktreeIdentity: managed.worktreeIdentity, worktreePath: managed.target.projectPath, branch: managed.branch } };
  if (kind === 'advanced-summary') {
    Object.assign(observed.managed, { head: 'd'.repeat(40) });
    Object.assign(observed.commit, { commit: 'd'.repeat(40), tree: 'e'.repeat(40) });
  }
  const evidence = new WorkflowEvidence(f.store, { inspect: async () => observed }, { now });
  const captured = await evidence.capture(attempt, check, terminal, { ...effectFence(), outputGapped: false }, new AbortController().signal);
  if (kind === 'changed-during-capture') {
    changeReview();
    expect(() => captured.commit()).toThrow();
    expect(f.attempts.get(attempt.attemptId).resolution).toBe('open');
    expect(f.artifacts()).toHaveLength(1);
  } else {
    captured.commit();
    expect(f.attempts.get(attempt.attemptId).resolution).toBe('succeeded');
    expect(f.artifacts().find(artifact => artifact.kind === (kind === 'advanced-summary' ? 'summary' : 'command'))?.outcome).toBe('pass');
  }
});
