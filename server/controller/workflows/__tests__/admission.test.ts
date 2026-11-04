import { afterEach, expect, mock, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import type { AutomationResult, AutomationStartResult } from '../../../../common/automation.js';
import type { WorkflowPlan } from '../../../../common/workflows.js';
import { WorkflowChatAdmission } from '../admission.js';
import { WorkflowAttempts } from '../attempts.js';
import type { WorkflowChatPort, WorkflowEffectFence, WorkflowOutputPort, WorkflowPreparedTurn, WorkflowRepositoryPort } from '../contracts.js';
import { workflowEffectiveInput } from '../inputs.js';
import { WorkflowResources } from '../resources.js';
import { recoverWorkflowAttempts } from '../recovery.js';
import { effectFence, fixture, plan, prepareManagedTarget } from './fixture.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const completed: AutomationResult = { kind: 'completed', commandOutcome: null, receivedOutputCoverage: 'complete',
  receipt: { state: 'completed', chatId: '1234567890123456', turnId: 'synthetic-turn', clientRequestId: 'synthetic-request',
    acceptedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', settledAt: '2026-01-01T00:00:00.000Z',
    output: { availability: 'available', completeness: 'complete', text: 'Synthetic output.' } } };

function setup(input: WorkflowPlan = plan(), observationTimeoutMs?: number) {
  const f = fixture(); fixtures.push(f);
  const now = () => '2026-01-01T00:00:00.000Z';
  const attempts = new WorkflowAttempts(f.store, { now });
  const resources = new WorkflowResources(f.store, now);
  const workflowId = f.write({ action: 'create', captainChatId: null, plan: input }).workflowId;
  f.activate(workflowId);
  const attempt = attempts.reserve(workflowId, 'check')!;
  const terminal = Promise.withResolvers<AutomationResult>();
  const revoked = new AbortController();
  const outputGapped = new AbortController();
  const shutdown = new AbortController();
  const effectRevoked = new AbortController();
  let invalidated = false;
  let observerCount = 0;
  let drift = false;
  const fence: WorkflowEffectFence = { get revoked() { return invalidated; },
    get revocationKind() { return invalidated ? 'intervention' : null; }, revokedSignal: effectRevoked.signal,
    get reason() { return invalidated ? 'Synthetic invalidation.' : null; }, shutdown: shutdown.signal };
  const start = mock(async (): Promise<AutomationStartResult> => {
    expect(attempts.get(attempt.attemptId).dispatchPhase).toBe('dispatching');
    expect(observerCount).toBe(1);
    terminal.resolve(completed);
    return { kind: 'published' };
  });
  const cancel = mock(async () => {});
  const release = mock(() => {});
  const chats = {
    prepare: mock(async (request): ReturnType<WorkflowChatPort['prepare']> => ({ kind: 'prepared', turn: {
      key: { serverInstanceId: 'synthetic-controller', chatId: '1234567890123456', turnId: 'synthetic-turn', clientRequestId: request.clientRequestId },
      effectiveInput: workflowEffectiveInput(drift ? { ...request, command: 'changed' } : request),
      control: { revoked: revoked.signal, outputGapped: outputGapped.signal, release }, start, cancel,
    } satisfies WorkflowPreparedTurn })),
    waitForTerminal: mock((_key, signal): Promise<AutomationResult> => new Promise((resolve, reject) => {
      observerCount++;
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      terminal.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    }).finally(() => { observerCount--; })),
    stop: mock(async () => ({ kind: 'stop-requested' as const, delivery: 'unknown' as const })),
    waitForOwnershipRelease: mock(async () => {}),
    inspect: mock(async () => ({ exists: true, ownsExecution: false, pendingInput: false })),
  } satisfies WorkflowChatPort;
  const repositories = { prepare: mock(async (current): ReturnType<WorkflowRepositoryPort['prepare']> => {
    return { kind: 'prepared', resource: prepareManagedTarget(resources, current) };
  }) } satisfies WorkflowRepositoryPort;
  const output = { capture: mock(async (_attempt, _task, _result, currentFence) => {
    expect(currentFence.revoked).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(attempts.get(attempt.attemptId).result).not.toBeNull();
    return { commit() {} };
  }) } satisfies WorkflowOutputPort;
  const failures: unknown[] = [];
  const admission = new WorkflowChatAdmission(attempts, chats, repositories, output,
    { onRevoked: () => { invalidated = true; effectRevoked.abort(); }, onFailure: error => failures.push(error), observationTimeoutMs });
  const run = () => admission.dispatch(attempt, fence);
  return { ...f, get store() { return f.store; }, get service() { return f.service; }, attempt, attempts, resources,
    admission, chats, repositories, output, run, start, cancel, release, terminal, revoked, outputGapped, shutdown, failures,
    observerCount: () => observerCount, drift: () => { drift = true; },
    claims: () => f.store.read(db => db.query('SELECT * FROM resource_claims WHERE attempt_id=?').all(attempt.attemptId)),
  };
}

test('observes instant completion before dispatch and retains the lease through output checking', async () => {
  const f = setup();
  await f.run();
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.output.capture).toHaveBeenCalledTimes(1);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.observerCount()).toBe(0);
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'unknown', result: { outputCaptured: false } });
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('output-unknown');
});

test('accepted evidence releases durable control and capacity before restart', async () => {
  const f = setup();
  f.output.capture.mockResolvedValueOnce({ commit() {
    f.store.transaction(db => db.query("UPDATE attempts SET resolution='succeeded',result_json=json_set(result_json,'$.outputCaptured',json('true')) WHERE id=?")
      .run(f.attempt.attemptId));
  } });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'succeeded', controlState: 'released', dispatchPhase: 'settled' });
  expect(f.claims()).toMatchObject([{ retained: 1, quarantined: 0 }]);
  expect(f.release).toHaveBeenCalledTimes(1);
  f.reopen();
  expect(await recoverWorkflowAttempts(f.store, () => '2026-01-02T00:00:00.000Z')).toBe(0);
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.phase).toBe('succeeded');
});

test('persists the terminal while start is still settling, before receipt eviction can erase it', async () => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const released = Promise.withResolvers<void>();
  f.start.mockImplementation(async () => { f.terminal.resolve(completed); entered.resolve(); await released.promise; return { kind: 'published' }; });
  const running = f.run();
  await entered.promise; await setImmediate();
  expect(f.attempts.get(f.attempt.attemptId).result).toMatchObject({ certainty: 'definite', termination: 'observed' });
  expect(f.output.capture).not.toHaveBeenCalled();
  expect(f.claims()).toHaveLength(1);
  released.resolve(); await running;
});

test('prepare rejection records a definite non-start without a chat observer', async () => {
  const f = setup();
  f.chats.prepare.mockResolvedValueOnce({ kind: 'rejected', code: 'AUTOMATION_INPUT_CHANGED' });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'not-started', result: { certainty: 'not-started' } });
  expect(f.start).not.toHaveBeenCalled(); expect(f.chats.waitForTerminal).not.toHaveBeenCalled();
  expect(f.claims()).toMatchObject([{ retained: 1, quarantined: 0 }]);
});

test('effective input drift cancels the unpublished capability', async () => {
  const f = setup(); f.drift();
  await f.run();
  expect(f.start).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('not-started');
  expect(f.release).toHaveBeenCalledTimes(1);
});

test.each(['not-started', 'unknown'] as const)('a direct %s start result disposes its observer', async kind => {
  const f = setup();
  f.start.mockResolvedValueOnce(kind === 'not-started' ? { kind, code: 'AUTOMATION_INPUT_CHANGED', inputPublished: true }
    : { kind, reason: 'Synthetic uncertain start.' });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe(kind);
  expect(f.observerCount()).toBe(0); expect(f.output.capture).not.toHaveBeenCalled();
  expect(f.claims()).toMatchObject([{ retained: kind === 'unknown' ? 0 : 1 }]);
});

test.each(['not-started', 'unknown'] as const)('an early terminal followed by %s start settles with resolvable attention', async kind => {
  const f = setup();
  f.start.mockImplementation(async () => {
    f.terminal.resolve(completed);
    await setImmediate();
    expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'open', controlState: 'leased', result: { termination: 'observed' } });
    return kind === 'not-started' ? { kind, code: 'SYNTHETIC_REJECTION', inputPublished: true }
      : { kind, reason: 'Synthetic lost start confirmation.' };
  });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'unknown', dispatchPhase: 'settled', controlState: 'released' });
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('output-unknown');
  expect(f.observerCount()).toBe(0);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(() => f.write({ action: 'resolve', workflowId: f.attempt.workflowId, taskId: 'check',
    attemptId: f.attempt.attemptId, generation: 1, resolution: 'not-started', releaseRisk: false,
    evidence: 'Synthetic incorrect non-start assertion.', commit: null })).toThrow('Definite execution evidence');
  expect(() => f.write({ action: 'resolve', workflowId: f.attempt.workflowId, taskId: 'check',
    attemptId: f.attempt.attemptId, generation: 1, resolution: 'abandon', releaseRisk: false,
    evidence: 'Synthetic operator resolution.', commit: null })).not.toThrow();
});

test('supersession cancels the captured turn without classifying it as operator intervention', async () => {
  const f = setup(); const entered = Promise.withResolvers<void>();
  f.start.mockImplementation(async () => { entered.resolve(); return { kind: 'published' }; });
  f.cancel.mockImplementation(async () => {
    f.terminal.resolve({ kind: 'interrupted', receipt: null, termination: 'observed', commandOutcome: null, receivedOutputCoverage: 'complete' });
  });
  const running = f.run(); await entered.promise;
  await f.admission.stop(f.attempt, 'superseded'); await running;
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.chats.stop).not.toHaveBeenCalled();
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'interrupted', revocationKind: 'superseded', dispatchPhase: 'settled' });
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('none');
});

test('manual takeover plus terminal persists intervention in the terminal transaction', async () => {
  const f = setup();
  f.start.mockImplementation(async () => { f.revoked.abort(); f.terminal.resolve(completed); return { kind: 'published' }; });
  await f.run(); f.reopen();
  expect(f.service.detail(f.attempt.workflowId).tasks[0]).toMatchObject({ hold: 'intervention',
    attempt: { resolution: 'unknown', controlState: 'revoked', result: { certainty: 'definite' } } });
  expect(f.output.capture).not.toHaveBeenCalled();
});

test('shutdown while waiting for terminal retains uncertainty and claims', async () => {
  const f = setup(); const entered = Promise.withResolvers<void>();
  f.start.mockImplementation(async () => { entered.resolve(); return { kind: 'published' }; });
  const running = f.run(); await entered.promise; f.shutdown.abort(); await running;
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'unknown', result: { termination: 'unknown' } });
  expect(f.claims()).toMatchObject([{ quarantined: 1 }]); expect(f.observerCount()).toBe(0);
});

test.each(['ownsExecution', 'pendingInput', 'missing'] as const)('unexpected %s prevents output attribution', async mutation => {
  const f = setup();
  f.chats.inspect.mockResolvedValueOnce({ exists: mutation !== 'missing', ownsExecution: mutation === 'ownsExecution', pendingInput: mutation === 'pendingInput' });
  await f.run();
  expect(f.output.capture).not.toHaveBeenCalled();
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('intervention');
});

test('late control input during Git observation cannot escape the live output fence', async () => {
  const f = setup();
  f.output.capture.mockImplementation(async (_attempt, _task, _result, fence) => {
    await setImmediate(); f.revoked.abort();
    expect(fence.revoked).toBe(true);
    return { commit() { throw new Error('Revoked output must not commit.'); } };
  });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId).controlState).toBe('revoked');
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('intervention');
});

test('post-terminal output loss remains sticky through output inspection', async () => {
  const f = setup();
  f.chats.waitForOwnershipRelease.mockImplementation(async () => { f.outputGapped.abort(); });
  await f.run();
  expect(f.output.capture.mock.calls[0]![3].outputGapped).toBe(true);
  expect(f.attempts.get(f.attempt.attemptId).result?.receivedOutputCoverage).toBe('gapped');
});

test('final ownership recheck discards prepared evidence before its commit', async () => {
  const f = setup(); const commit = mock(() => {});
  f.output.capture.mockResolvedValueOnce({ commit });
  f.chats.inspect.mockResolvedValueOnce({ exists: true, ownsExecution: false, pendingInput: false })
    .mockResolvedValueOnce({ exists: true, ownsExecution: true, pendingInput: false });
  await f.run();
  expect(commit).not.toHaveBeenCalled();
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('intervention');
});

test('command deadline requests exact cancellation but does not claim native termination', async () => {
  const f = setup();
  f.start.mockResolvedValueOnce({ kind: 'published' });
  f.cancel.mockImplementation(async () => {
    f.terminal.resolve({ kind: 'interrupted', receipt: null, termination: 'requested',
      commandOutcome: null, receivedOutputCoverage: 'unknown' });
  });
  await f.run(); await f.admission.waitForStops();
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'interrupted',
    controlState: 'revoked', result: { termination: 'unknown' } });
  expect(f.claims()).toMatchObject([{ quarantined: 1 }]);
});

test('stop during target preparation prevents a later chat start', async () => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const prepare = f.repositories.prepare.getMockImplementation()!;
  f.repositories.prepare.mockImplementation(async (...args) => { const result = await prepare(...args); entered.resolve(); await release.promise; return result; });
  const running = f.run(); await entered.promise;
  await f.admission.stop(f.attempt); release.resolve(); await running;
  expect(f.chats.prepare).not.toHaveBeenCalled();
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('not-started');
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('intervention');
});

test('storage failure while binding the turn cancels it without dispatch', async () => {
  const f = setup(); const prepare = f.chats.prepare.getMockImplementation()!;
  f.chats.prepare.mockImplementation(async input => { const turn = await prepare(input); f.controls.failCommit = true; return turn; });
  await expect(f.run()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
  expect(f.start).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledTimes(1);
  f.reopen();
  expect(f.service.attempts(f.attempt.workflowId)[0]?.dispatchPhase).toBe('preparing');
});

test('early failure followed by takeover remains held after start settles and restart', async () => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  f.start.mockImplementation(async () => {
    f.terminal.resolve({ kind: 'failed', certainty: 'not-started', receipt: null, detail: 'Synthetic rejection.',
      commandOutcome: null, receivedOutputCoverage: 'unknown' });
    entered.resolve(); await release.promise; return { kind: 'published' };
  });
  const running = f.run(); await entered.promise; await setImmediate();
  expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('not-started');
  f.revoked.abort(); release.resolve(); await running; f.reopen();
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('intervention');
  expect(new WorkflowAttempts(f.store, { now: () => '2026-01-02T00:00:00.000Z' })
    .reserve(f.attempt.workflowId, 'check')).toBeNull();
});

test('a real early terminal disarms the command deadline while start is pending', async () => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  f.start.mockImplementation(async () => { f.terminal.resolve(completed); entered.resolve(); await release.promise; return { kind: 'published' }; });
  const running = f.run(); await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(f.cancel).not.toHaveBeenCalled();
  release.resolve(); await running;
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('output-unknown');
});

test('throwing after resource dispatch quarantines preparation and exposes resolution', async () => {
  const f = setup();
  f.repositories.prepare.mockImplementation(async current => {
    const op = f.resources.plan({ operationId: crypto.randomUUID(), attemptId: current.attemptId,
      kind: 'worktree', resourceKey: current.attemptId, payload: '{}' });
    f.resources.begin(op.id, effectFence());
    throw new Error('Synthetic lost resource reply.');
  });
  await f.run();
  expect(f.claims()).toMatchObject([{ quarantined: 1 }]);
  expect(f.store.read(db => db.query('SELECT status FROM operation_intents').all())).toEqual([{ status: 'unknown' }]);
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('output-unknown');
});

test.each(['unknown', 'not-started'] as const)('a %s preparation result quarantines any unobserved resource dispatch', async kind => {
  const f = setup(); const operationId = crypto.randomUUID();
  f.repositories.prepare.mockImplementation(async current => {
    f.resources.plan({ operationId, attemptId: current.attemptId, kind: 'worktree', resourceKey: current.attemptId, payload: '{}' });
    f.resources.begin(operationId, effectFence());
    return { kind, detail: 'Synthetic preparation outcome.' };
  });
  await f.run();
  expect(f.resources.get(operationId).status).toBe('unknown');
  expect(f.claims()).toMatchObject([{ quarantined: 1, retained: 0 }]);
  expect(() => f.resources.observe(operationId, 'not-started', '{}')).toThrow('does not prove');
});

for (const stage of ['first-inspection', 'capture', 'final-inspection'] as const) {
  test.each(['deadline', 'stop', 'shutdown'] as const)(`${stage} is bounded by %s and late evidence cannot commit`, async abort => {
    const f = setup(plan(), abort === 'deadline' ? 20 : undefined);
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const commit = mock(() => {});
    const snapshot = { exists: true, ownsExecution: false, pendingInput: false };
    if (stage === 'capture') f.output.capture.mockImplementation(async () => { entered.resolve(); await finish.promise; return { commit }; });
    else {
      f.output.capture.mockResolvedValueOnce({ commit });
      if (stage === 'final-inspection') f.chats.inspect.mockResolvedValueOnce(snapshot);
      f.chats.inspect.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; return snapshot; });
    }
    const running = f.run(); await entered.promise;
    if (abort === 'stop') await f.admission.stop(f.attempt);
    if (abort === 'shutdown') f.shutdown.abort();
    await running;
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('unknown');
    expect(f.chats.inspect).toHaveBeenCalledTimes(stage === 'final-inspection' ? 2 : 1);
    finish.resolve(); await setImmediate();
    expect(commit).not.toHaveBeenCalled();
    expect(f.attempts.get(f.attempt.attemptId).resolution).toBe('unknown');
  });
}

test.each(['pending-terminal', 'early-failure'] as const)('Stop cannot resolve %s while admission still owns start', async phase => {
  const f = setup(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  f.start.mockImplementation(async () => {
    if (phase === 'early-failure') f.terminal.resolve({ kind: 'failed', certainty: 'not-started', receipt: null,
      detail: 'Synthetic early rejection.', commandOutcome: null, receivedOutputCoverage: 'unknown' });
    entered.resolve(); await finish.promise; return { kind: 'published' };
  });
  const running = f.run(); await entered.promise; await setImmediate();
  f.write({ action: 'stop', workflowId: f.attempt.workflowId });
  await f.admission.stop(f.attempt);
  const resolution = { action: 'resolve' as const, workflowId: f.attempt.workflowId, taskId: 'check',
    attemptId: f.attempt.attemptId, generation: 1, resolution: 'abandon' as const, releaseRisk: true,
    evidence: 'Synthetic operator risk acknowledgement.', commit: null };
  expect(() => f.write(resolution)).toThrow('Uncertain attempt changed');
  expect(f.claims()).toMatchObject([{ retained: 0, risk_released: 0 }]);
  finish.resolve(); f.terminal.resolve(completed); await running;
  expect(() => f.write(resolution)).not.toThrow();
});

test.each(['\u0001', '\u6f22'])('escaped terminal detail preserves definite non-start evidence (%s)', async character => {
  const f = setup();
  f.start.mockImplementation(async () => {
    f.terminal.resolve({ kind: 'failed', certainty: 'not-started', receipt: null, detail: character.repeat(4096),
      commandOutcome: null, receivedOutputCoverage: 'complete' });
    return { kind: 'published' };
  });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId)).toMatchObject({ resolution: 'not-started', result: { certainty: 'not-started' } });
});

test.each(['cwd', 'signal'] as const)('oversized command %s retains definite terminal evidence through admission', async field => {
  const f = setup();
  f.start.mockImplementation(async () => {
    f.terminal.resolve({ kind: 'failed', certainty: 'definite', receipt: null, detail: 'Synthetic command exit.',
      receivedOutputCoverage: 'complete', commandOutcome: { outcome: 'failed', exitCode: 7,
        capture: 'complete', signal: field === 'signal' ? '\u0001'.repeat(3000) : null,
        cwd: { kind: 'reported', path: field === 'cwd' ? '/' + '\u0001'.repeat(3000) : '/synthetic/managed' } } });
    return { kind: 'published' };
  });
  await f.run();
  expect(f.attempts.get(f.attempt.attemptId).result).toMatchObject({ certainty: 'definite', termination: 'observed',
    commandOutcome: { outcome: 'failed', exitCode: 7, capture: 'complete', cwd: { kind: 'unavailable' } } });
  expect(f.output.capture).toHaveBeenCalledTimes(1);
});

test('Stop interrupts output ownership waiting without native termination claims', async () => {
  const f = setup(); const waiting = Promise.withResolvers<void>();
  f.chats.waitForOwnershipRelease.mockImplementation((_id, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); waiting.resolve();
  }));
  const running = f.run(); await waiting.promise;
  await f.admission.stop(f.attempt); await running;
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('intervention');
  expect(f.output.capture).not.toHaveBeenCalled();
});

test('ownership that never releases produces bounded attention rather than retaining a live observer', async () => {
  const f = setup(plan(), 10);
  f.chats.waitForOwnershipRelease.mockImplementation((_id, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await f.run();
  expect(f.service.detail(f.attempt.workflowId).tasks[0]?.hold).toBe('output-unknown');
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.output.capture).not.toHaveBeenCalled();
});

test('a gap after capture preparation prevents a non-checking evidence port from committing', async () => {
  const f = setup(); const commit = mock(() => {});
  f.output.capture.mockImplementation(async () => { f.outputGapped.abort(); return { commit }; });
  await f.run();
  expect(commit).not.toHaveBeenCalled();
  expect(f.attempts.get(f.attempt.attemptId).result?.receivedOutputCoverage).toBe('gapped');
});
