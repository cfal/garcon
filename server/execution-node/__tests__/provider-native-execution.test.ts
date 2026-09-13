import { expect, mock, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentDispatchOutcome, AgentExecutionLifetimeRequest, AgentIntegration, AgentProducerEvent } from '@garcon/server-agent-interface';
import type { ProviderConfigurationResolver } from '../../execution-nodes/provider-configuration.js';
import type { ProviderExecutionDelivery, ProviderExecutionInput, ProviderExecutionRequest } from '../../execution-nodes/provider-execution.js';
import { LocalProviderExecutionService } from '../local-provider-execution.js';

function fixture() {
  const dispatch = Promise.withResolvers<AgentDispatchOutcome>();
  const settlement = Promise.withResolvers<void>();
  const nativeAbort = mock(async () => true);
  const native = { dispatch: dispatch.promise, settled: settlement.promise, abort: nativeAbort };
  const begin = mock((_input: AgentExecutionLifetimeRequest) => native);
  const integration = {
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [] },
    execution: { start: mock(async () => ({})), resume: mock(async () => ({})), abort: mock(async () => true), runningSessions: () => [] },
    executionLifetime: { begin }, compaction: null,
    steering: { captureTarget: mock(() => ({})), steer: mock(async () => ({ kind: 'accepted' as const })) }, goals: null,
  } satisfies ConstructorParameters<typeof LocalProviderExecutionService>[0];
  const configuration = { resolve: async () => ({ model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none', endpoint: null,
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} } }) } satisfies ProviderConfigurationResolver;
  const caller = new AbortController();
  const source = new AbortController();
  const events: AgentProducerEvent[] = [];
  const delivery = { output: { signal: source.signal, emit(event) { source.signal.throwIfAborted(); events.push(event); } },
    admission: { signal: caller.signal, async markStarted() {} } } satisfies ProviderExecutionDelivery;
  const input = { prompt: 'synthetic input', attachments: [], carriedContext: null } satisfies ProviderExecutionInput;
  const request: ProviderExecutionRequest = { kind: 'start', chatId: 'synthetic-chat', projectPath: '/synthetic-project', runId: 'synthetic-run',
    configuration: { model: 'synthetic-model', settings: null, endpoint: null } };
  const service = new LocalProviderExecutionService(integration, configuration);
  return { service, retained: service.retained!, integration, configuration, request, input, delivery, caller, source,
    dispatch, settlement, nativeAbort, native, begin, events };
}

test('changing the returned attempt cannot retarget retained native cancellation', async () => {
  const f = fixture();
  const operation = await f.retained.prepare(f.request, f.caller.signal);
  const attempt = f.retained.beginDispatch(operation, f.input, f.delivery);
  const replacementAbort = mock(async () => false);
  f.native.abort = replacementAbort;
  f.dispatch.resolve({ kind: 'accepted' });
  await attempt.dispatch;
  expect(await f.retained.abort(operation)).toBe(true);
  expect(f.nativeAbort).toHaveBeenCalledTimes(1);
  expect(replacementAbort).not.toHaveBeenCalled();
  f.settlement.resolve();
  await attempt.settled;
});

test.each(['confirmed', 'unconfirmed'] as const)('%s settlement fences already-prepared and new controls', async (outcome) => {
  const f = fixture();
  const operation = await f.retained.prepare(f.request, f.caller.signal);
  const attempt = f.retained.beginDispatch(operation, f.input, f.delivery);
  const observed = attempt.settled.catch((error: unknown) => error);
  f.begin.mock.calls[0]![0].request.output.emit({ type: 'session', session: {
    agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null,
  } });
  f.dispatch.resolve({ kind: 'accepted' });
  await attempt.dispatch;
  const control = await f.retained.prepareSteer(operation, new AbortController().signal);
  if (control.kind !== 'ready') throw new Error('Synthetic control was not prepared');
  const failure = new Error('Synthetic settlement observation failed');
  if (outcome === 'confirmed') f.settlement.resolve();
  else f.settlement.reject(failure);
  expect(await observed).toBe(outcome === 'confirmed' ? undefined : failure);
  const prepareDelivery = mock(async () => {});
  expect(await f.retained.steer(operation, control.target, { input: 'synthetic steer',
    clientMessageId: 'synthetic-input', prepareDelivery })).toMatchObject({ kind: 'rejected', reason: 'turn-changed' });
  expect(await f.retained.prepareSteer(operation, new AbortController().signal)).toEqual({ kind: 'unavailable' });
  expect(prepareDelivery).not.toHaveBeenCalled();
  expect(f.integration.steering.steer).not.toHaveBeenCalled();
  expect(await f.retained.abort(operation)).toBe(true);
  expect(f.nativeAbort).toHaveBeenCalledTimes(1);
});

test('native execution remains unavailable without an explicit lifetime facet', () => {
  const f = fixture();
  const integration = { ...f.integration, executionLifetime: null } satisfies Pick<AgentIntegration,
    'descriptor' | 'execution' | 'executionLifetime' | 'compaction' | 'steering' | 'goals'>;
  expect(new LocalProviderExecutionService(integration, f.configuration).retained).toBeNull();
});

test('preparation enters no native work and retained dispatch transfers a single exact attempt', async () => {
  const f = fixture();
  const operation = await f.retained.prepare(f.request, f.caller.signal);
  expect(f.begin).not.toHaveBeenCalled();
  const attempt = f.retained.beginDispatch(operation, f.input, f.delivery);
  expect(attempt).not.toBeInstanceOf(Promise);
  expect(Object.isFrozen(attempt)).toBe(true);
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.begin.mock.calls[0]![0]).toMatchObject({ kind: 'start', request: { chatId: 'synthetic-chat', projectPath: '/synthetic-project' } });
  expect(() => f.retained.beginDispatch(operation, f.input, f.delivery)).toThrow('already dispatched');
  f.dispatch.resolve({ kind: 'accepted' });
  expect(await attempt.dispatch).toEqual({ kind: 'accepted' });
  expect(f.integration.execution.start).not.toHaveBeenCalled();
  f.settlement.resolve();
  await attempt.settled;
});

test('post-entry failure keeps cleanup addressable without a returned session or legacy handle', async () => {
  const f = fixture();
  const operation = await f.retained.prepare(f.request, f.caller.signal);
  const attempt = f.retained.beginDispatch(operation, f.input, f.delivery);
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  const error = new Error('Synthetic native entry followed by failure');
  f.dispatch.reject(error);
  expect(await attempt.dispatch).toEqual({ kind: 'unknown', error });
  expect(await f.retained.abort(operation)).toBe(true);
  expect(await f.retained.abort(operation)).toBe(true);
  expect(f.nativeAbort).toHaveBeenCalledTimes(1);
  expect(f.integration.execution.abort).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  f.settlement.resolve();
  await completion;
});

test('cancellation after a visible terminal still reaches native work and preserves late output', async () => {
  const f = fixture();
  const operation = await f.retained.prepare(f.request, f.caller.signal);
  const attempt = f.retained.beginDispatch(operation, f.input, f.delivery);
  f.dispatch.resolve({ kind: 'accepted' });
  await attempt.dispatch;
  const output = f.begin.mock.calls[0]![0].request.output;
  output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  let settled = false;
  const completion = attempt.settled.then(() => { settled = true; });
  f.caller.abort();
  await Promise.resolve();
  expect(f.nativeAbort).toHaveBeenCalledTimes(1);
  expect(await f.retained.abort(operation)).toBe(true);
  expect(settled).toBe(false);
  output.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-12T00:00:00.000Z', 'synthetic late output') }] });
  expect(f.events.map((event) => event.type)).toEqual(['run-ended', 'rows']);
  expect(await f.retained.prepareSteer(operation, new AbortController().signal)).toEqual({ kind: 'unavailable' });
  f.settlement.resolve();
  await completion;
});

test('unconfirmed settlement retains the admission cancellation listener', async () => {
  const f = fixture();
  const operation = await f.retained.prepare(f.request, f.caller.signal);
  const attempt = f.retained.beginDispatch(operation, f.input, f.delivery);
  const completion = attempt.settled.catch((error: unknown) => error);
  f.dispatch.resolve({ kind: 'accepted' });
  await attempt.dispatch;
  const error = new Error('Synthetic settlement observation failed');
  f.settlement.reject(error);
  expect(await completion).toBe(error);
  f.caller.abort();
  await Promise.resolve();
  expect(f.nativeAbort).toHaveBeenCalledTimes(1);
  expect(await f.retained.abort(operation)).toBe(true);
});

test('pre-entry cancellation and validation failure never invoke native dispatch', async () => {
  const cancelled = fixture();
  const operation = await cancelled.retained.prepare(cancelled.request, cancelled.caller.signal);
  expect(await cancelled.retained.abort(operation)).toBe(false);
  expect(() => cancelled.retained.beginDispatch(operation, cancelled.input, cancelled.delivery)).toThrow();
  expect(cancelled.begin).not.toHaveBeenCalled();
  const invalid = fixture();
  const resumed = await invalid.retained.prepare({ ...invalid.request, kind: 'resume', agentSessionId: 'synthetic-session', nativeSession: null }, invalid.caller.signal);
  expect(() => invalid.retained.beginDispatch(resumed, { ...invalid.input, carriedContext: { prefix: 'synthetic' } } as ProviderExecutionInput, invalid.delivery))
    .toThrow('Only a new native session');
  expect(invalid.begin).not.toHaveBeenCalled();
  expect(await invalid.retained.abort(resumed)).toBe(false);
});
