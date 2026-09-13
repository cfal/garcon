import { expect, mock, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentLogger, AgentProducerEvent, AgentStartRequestV5 } from '@garcon/server-agent-interface';
import { createAgentProducerAdapter } from '../producer-adapter.js';
import type {
  AgentRuntimeDispatchOutcome, AgentRuntimeExecution, AgentRuntimeExecutionAttempt,
  AgentRuntimeExecutionLifetime, AgentRuntimeExecutionLifetimeRequest, AgentRuntimePublisher,
} from '../runtime-events.js';

const session = { agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null };
const logger = { debug() {}, info() {}, warn() {}, error() {} } satisfies AgentLogger;

function fixture() {
  const events: AgentProducerEvent[] = [];
  const runtime = { start: mock(async () => session), resume: mock(async () => {}),
    abort: mock(async () => true), runningSessions: () => [] } satisfies AgentRuntimeExecution;
  const captures: ReturnType<typeof capture>[] = [];
  function capture(input: AgentRuntimeExecutionLifetimeRequest, publish: AgentRuntimePublisher) {
    const dispatch = Promise.withResolvers<AgentRuntimeDispatchOutcome>();
    const settlement = Promise.withResolvers<void>();
    const abort = mock(async () => true);
    const attempt = { dispatch: dispatch.promise, settled: settlement.promise, abort } satisfies AgentRuntimeExecutionAttempt;
    return { input, publish, dispatch, settlement, abort, attempt };
  }
  const lifetime = { begin(input, publish) {
    const owner = capture(input, publish);
    captures.push(owner);
    return owner.attempt;
  } } satisfies AgentRuntimeExecutionLifetime;
  const adapter = createAgentProducerAdapter(runtime, logger, lifetime);
  const request = { chatId: 'synthetic-chat', projectPath: '/synthetic-project', runId: 'synthetic-run',
    model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none',
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null,
    output: { emit(event) { events.push(event); } },
    admission: { signal: new AbortController().signal, async markStarted() {} },
    prompt: 'synthetic prompt', attachments: [], carriedContext: null } satisfies AgentStartRequestV5;
  return { adapter, runtime, captures, request, events };
}

test('legacy providers expose no settlement attestation and retain their original execution path', async () => {
  const f = fixture();
  const adapter = createAgentProducerAdapter(f.runtime, logger);
  expect(adapter.executionLifetime).toBeNull();
  const handle = await adapter.execution.start(f.request);
  expect(await adapter.execution.abort(handle)).toBe(true);
  expect(f.runtime.start).toHaveBeenCalledTimes(1);
  expect(f.runtime.abort).toHaveBeenCalledTimes(1);
});

test('cleanup is returned synchronously and remains owned after fallback session publication throws', async () => {
  const f = fixture();
  const failure = new Error('Synthetic session publication failed');
  const attempt = f.adapter.executionLifetime!.begin({ kind: 'start', request: { ...f.request, output: { emit() { throw failure; } } } });
  const native = f.captures[0]!;
  expect(Object.isFrozen(attempt)).toBe(true);
  expect(attempt).not.toBeInstanceOf(Promise);
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  native.dispatch.resolve({ kind: 'accepted', session });
  expect(await attempt.dispatch).toEqual({ kind: 'unknown', error: failure });
  expect(await attempt.abort()).toBe(true);
  expect(native.abort).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  expect(f.runtime.start).not.toHaveBeenCalled();
  native.settlement.resolve();
  await completion;
  expect(settled).toBe(true);
});

test('terminal output and abort acknowledgement leave the exact native settlement pending', async () => {
  const f = fixture();
  const attempt = f.adapter.executionLifetime!.begin({ kind: 'start', request: f.request });
  const native = f.captures[0]!;
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  native.dispatch.resolve({ kind: 'accepted', session });
  expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
  native.publish({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  expect(await attempt.abort()).toBe(true);
  expect(settled).toBe(false);
  native.publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-12T00:00:00.000Z', 'synthetic late output') }] });
  expect(f.events.map((event) => event.type)).toEqual(['session', 'run-ended', 'rows']);
  native.settlement.resolve();
  await completion;
});

test('an unclassified native dispatch rejection is unknown and retains cancellation', async () => {
  const f = fixture();
  const attempt = f.adapter.executionLifetime!.begin({ kind: 'start', request: f.request });
  const native = f.captures[0]!;
  const failure = new Error('Synthetic failure after native entry');
  native.dispatch.reject(failure);
  expect(await attempt.dispatch).toEqual({ kind: 'unknown', error: failure });
  expect(await attempt.abort()).toBe(true);
  native.settlement.resolve();
  await attempt.settled;
});

test('settlement observation failure stays rejected after successful dispatch', async () => {
  const f = fixture();
  const attempt = f.adapter.executionLifetime!.begin({ kind: 'start', request: f.request });
  const native = f.captures[0]!;
  const observed = attempt.settled.catch((error: unknown) => error);
  native.dispatch.resolve({ kind: 'accepted', session });
  expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
  const failure = new Error('Synthetic unconfirmed process exit');
  native.settlement.reject(failure);
  expect(await observed).toBe(failure);
  expect(await attempt.abort()).toBe(true);
});

test('request mutation and a replacement attempt cannot change a captured cleanup target', async () => {
  const f = fixture();
  const input = { kind: 'start', request: f.request } as const;
  const first = f.adapter.executionLifetime!.begin(input);
  const original = f.captures[0]!;
  const replacementAbort = mock(async () => false);
  original.attempt.abort = replacementAbort;
  Object.assign(input, { kind: 'resume', request: { ...f.request, runId: 'synthetic-replacement' } });
  original.dispatch.resolve({ kind: 'accepted', session });
  expect(await first.dispatch).toEqual({ kind: 'accepted' });
  expect(f.events).toEqual([{ type: 'session', session }]);
  const second = f.adapter.executionLifetime!.begin({ kind: 'start', request: { ...f.request, runId: 'synthetic-successor' } });
  f.captures[1]!.dispatch.resolve({ kind: 'accepted', session });
  expect(await second.dispatch).toEqual({ kind: 'accepted' });
  expect(await first.abort()).toBe(true);
  expect(original.abort).toHaveBeenCalledTimes(1);
  expect(replacementAbort).not.toHaveBeenCalled();
  expect(f.captures[1]!.abort).not.toHaveBeenCalled();
  original.settlement.resolve(); f.captures[1]!.settlement.resolve();
  await Promise.all([first.settled, second.settled]);
});

test.each(['confirmed', 'unconfirmed'] as const)('%s native settlement retires goal control without losing cancellation', async (outcome) => {
  const f = fixture();
  const attempt = f.adapter.executionLifetime!.begin({ kind: 'start', request: f.request });
  const native = f.captures[0]!;
  const observed = attempt.settled.catch((error: unknown) => error);
  native.dispatch.resolve({ kind: 'accepted', session });
  await attempt.dispatch;
  const failure = new Error('Synthetic settlement observation failed');
  if (outcome === 'confirmed') native.settlement.resolve();
  else native.settlement.reject(failure);
  expect(await observed).toBe(outcome === 'confirmed' ? undefined : failure);
  const deliver = mock(async () => true);
  expect(await f.adapter.submitGoalControl({ ...f.request, agentSessionId: session.agentSessionId,
    nativeSession: null, runId: 'synthetic-goal', async beforeDelivery() {} }, deliver)).toBe(false);
  expect(deliver).not.toHaveBeenCalled();
  expect(await attempt.abort()).toBe(true);
  expect(native.abort).toHaveBeenCalledTimes(1);
});

test.each(['resume', 'compact'] as const)('%s keeps its native lifetime without publishing another session', async (kind) => {
  const f = fixture();
  const attempt = f.adapter.executionLifetime!.begin({ kind, request: { ...f.request, agentSessionId: session.agentSessionId, nativeSession: null } });
  const native = f.captures[0]!;
  expect(native.input.kind).toBe(kind);
  expect(native.input.request).not.toHaveProperty('output');
  native.dispatch.resolve({ kind: 'accepted', session: null });
  expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
  expect(f.events).toEqual([]);
  expect(f.runtime.resume).not.toHaveBeenCalled();
  native.settlement.resolve();
  await attempt.settled;
});

test('definite refusal before native entry preserves the admitted predecessor control target', async () => {
  const f = fixture();
  const first = f.adapter.executionLifetime!.begin({ kind: 'start', request: f.request });
  f.captures[0]!.dispatch.resolve({ kind: 'accepted', session });
  await first.dispatch;
  const refused = f.adapter.executionLifetime!.begin({ kind: 'start', request: { ...f.request, runId: 'synthetic-refused' } });
  const error = new Error('Synthetic pre-entry refusal');
  f.captures[1]!.dispatch.resolve({ kind: 'rejected', error });
  f.captures[1]!.settlement.resolve();
  expect(await refused.dispatch).toEqual({ kind: 'rejected', error });
  const delivered = await f.adapter.submitGoalControl({ ...f.request, agentSessionId: session.agentSessionId, nativeSession: null,
    runId: 'synthetic-goal', async beforeDelivery(handoff) { handoff.validate(); handoff.commit(); } }, async (request, publish) => {
    expect(publish).toBe(f.captures[0]!.publish);
    await request.beforeDelivery({ validate() {}, commit() {} });
    return true;
  });
  expect(delivered).toBe(true);
  f.captures[0]!.settlement.resolve();
  await Promise.all([first.settled, refused.settled]);
});
