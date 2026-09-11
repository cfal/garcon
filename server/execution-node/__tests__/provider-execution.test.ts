import { expect, mock, test } from 'bun:test';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type {
  AgentExecutionHandle,
  AgentIntegration,
  AgentProducerEvent,
  AgentResumeRequestV5,
  AgentStartRequestV5,
  AgentSteerRequest,
  AgentSteerTargetRequest,
  AgentGoalControlRequest,
} from '@garcon/server-agent-interface';
import type {
  ProviderExecutionDelivery,
  ProviderExecutionInput,
  ProviderExecutionOperation,
  ProviderExecutionRequest,
} from '../../execution-nodes/provider-execution.js';
import { LocalProviderExecutionService } from '../local-provider-execution.js';
import { LocalProviderConfigurationService } from '../local-provider-configuration.js';

function fixture() {
  const nativeHandle = Object.freeze({});
  const integration = {
    descriptor: {
      id: 'synthetic', label: 'Synthetic', icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: ['openai-compatible'], configuration: [],
    },
    settings: {
      describe: () => [],
      defaults: () => ({ ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'original' } }),
      parse: mock((input: AgentSettingsEnvelope) => input),
      applyPatch: (input: AgentSettingsEnvelope) => input,
      migrate: async (input: AgentSettingsEnvelope) => input,
    },
    endpoints: { validate: mock(async (_endpoint: AgentEndpointSelection) => {}) },
    sessionConfiguration: null,
    execution: {
      start: mock(async (_request: AgentStartRequestV5) => nativeHandle),
      resume: mock(async (_request: AgentResumeRequestV5) => nativeHandle),
      abort: mock(async (_handle: AgentExecutionHandle) => true),
      runningSessions: () => [],
    },
    compaction: { compact: mock(async (_request: AgentResumeRequestV5) => nativeHandle) },
    steering: {
      captureTarget: mock((_request: AgentSteerTargetRequest) => Object.freeze({})),
      steer: mock(async (request: AgentSteerRequest) => {
        await request.prepareDelivery();
        return { kind: 'accepted' as const };
      }),
    },
    goals: {
      submitControl: mock(async (request: AgentGoalControlRequest) => {
        await request.beforeDelivery({ validate() {}, commit() {} });
        return true;
      }),
    },
  } satisfies Pick<AgentIntegration,
    'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration' | 'execution' | 'compaction' | 'steering' | 'goals'>;
  const request: ProviderExecutionRequest = {
    kind: 'start', chatId: 'synthetic-chat', projectPath: '/synthetic-project', runId: 'synthetic-run',
    configuration: { model: 'synthetic-model', settings: null, endpoint: null },
  };
  const input: ProviderExecutionInput = { prompt: 'synthetic input', attachments: [], carriedContext: null };
  const controller = new AbortController();
  const events: AgentProducerEvent[] = [];
  const delivery = {
    output: { emit(event: AgentProducerEvent) { events.push(event); } },
    admission: { signal: controller.signal, markStarted: mock(async () => {}) },
  } satisfies ProviderExecutionDelivery;
  const configuration = new LocalProviderConfigurationService(integration);
  return { integration, configuration, request, input, controller, delivery, nativeHandle, events,
    service: new LocalProviderExecutionService(integration, configuration) };
}

test('preparation dispatches nothing and protects its captured configuration from later changes', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  expect(f.integration.execution.start).not.toHaveBeenCalled();
  expect(f.delivery.admission.markStarted).not.toHaveBeenCalled();
  expect(Reflect.ownKeys(prepared)).toEqual([]);
  expect(Object.isFrozen(prepared)).toBe(true);
  Object.assign(f.request, { projectPath: '/changed-project' });
  Object.assign(f.request.configuration, { model: 'changed-model' });
  f.integration.settings.defaults = () => ({ ownerId: 'synthetic', schemaVersion: 1, values: { profile: 'changed' } });
  await f.service.dispatch(prepared, f.input, f.delivery);
  expect(f.integration.execution.start.mock.calls[0]![0]).toMatchObject({
    projectPath: '/synthetic-project', model: 'synthetic-model',
    settings: { values: { profile: 'original' } },
  });
  expect(f.integration.settings.parse).toHaveBeenCalledTimes(1);
});

test('rejects foreign and forged operations before dispatch or cancellation', async () => {
  const f = fixture();
  const other = fixture();
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  await expect(other.service.dispatch(prepared, f.input, f.delivery)).rejects.toThrow('operation is invalid');
  await expect(f.service.dispatch({} as ProviderExecutionOperation, f.input, f.delivery)).rejects.toThrow('operation is invalid');
  await expect(other.service.abort(prepared)).rejects.toThrow('operation is invalid');
  expect(f.integration.execution.start).not.toHaveBeenCalled();
  expect(other.integration.execution.abort).not.toHaveBeenCalled();
});

test.each(['success', 'failure'] as const)('dispatch is consumed once even after native %s', async (outcome) => {
  const f = fixture();
  const result = Promise.withResolvers<AgentExecutionHandle>();
  f.integration.execution.start.mockImplementation(() => result.promise);
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  const pending = f.service.dispatch(prepared, f.input, f.delivery);
  const observed = pending.catch((error: unknown) => error);
  await expect(f.service.dispatch(prepared, f.input, f.delivery)).rejects.toThrow('already dispatched');
  const failure = new Error('synthetic dispatch failure');
  if (outcome === 'success') result.resolve(f.nativeHandle);
  else result.reject(failure);
  expect(await observed).toBe(outcome === 'success' ? undefined : failure);
  await expect(f.service.dispatch(prepared, f.input, f.delivery)).rejects.toThrow('already dispatched');
  expect(f.integration.execution.start).toHaveBeenCalledTimes(1);
});

test('releasing unused preparation is idempotent and prevents native dispatch', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  f.service.release(prepared);
  f.service.release(prepared);
  await expect(f.service.dispatch(prepared, f.input, f.delivery)).rejects.toThrow('already released');
  expect(await f.service.abort(prepared)).toBe(false);
  expect(f.integration.execution.start).not.toHaveBeenCalled();
  expect(f.integration.execution.abort).not.toHaveBeenCalled();
});

test('preparation cancellation cannot cancel admitted execution after preparation finishes', async () => {
  const f = fixture();
  const preparation = new AbortController();
  const prepared = await f.service.prepare(f.request, preparation.signal);
  preparation.abort(new Error('synthetic preparation cleanup'));
  await f.service.dispatch(prepared, f.input, f.delivery);
  f.service.release(prepared);
  expect(f.integration.execution.start).toHaveBeenCalledTimes(1);
  expect(f.integration.execution.start.mock.calls[0]![0].admission.signal.aborted).toBe(false);
  expect(f.integration.execution.abort).not.toHaveBeenCalled();
  expect(await f.service.abort(prepared)).toBe(true);
});

test('execution admission cancellation before dispatch prevents native execution', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  f.controller.abort(new DOMException('synthetic cancellation', 'AbortError'));
  await expect(f.service.dispatch(prepared, f.input, f.delivery)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.integration.execution.start).not.toHaveBeenCalled();
  expect(f.integration.execution.abort).not.toHaveBeenCalled();
});

test('abort before dispatch preserves cancellation separately from releasing preparation', async () => {
  const f = fixture();
  const operation = await f.service.prepare(f.request, f.controller.signal);
  expect(await f.service.abort(operation)).toBe(false);
  await expect(f.service.dispatch(operation, f.input, f.delivery)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.integration.execution.start).not.toHaveBeenCalled();
});

test('a rejected session publication cannot enable controls against an unaccepted native binding', async () => {
  const f = fixture();
  const failure = new Error('synthetic publication rejection');
  f.delivery.output.emit = () => { throw failure; };
  f.integration.execution.start.mockImplementation(async (request) => {
    expect(() => request.output.emit({ type: 'session', session: {
      agentSessionId: 'synthetic-rejected-session', nativeSession: null, nativeSeedReceipt: null,
    } })).toThrow(failure);
    return f.nativeHandle;
  });
  const operation = await f.service.prepare(f.request, f.controller.signal);
  await f.service.dispatch(operation, f.input, f.delivery);
  expect(await f.service.prepareSteer(operation, f.controller.signal)).toEqual({ kind: 'unavailable' });
  expect(f.integration.steering.captureTarget).not.toHaveBeenCalled();
});

test('cancellation during validation leaves no prepared operation', async () => {
  const f = fixture();
  const validation = Promise.withResolvers<void>();
  const resolve = f.configuration.resolve.bind(f.configuration);
  f.configuration.resolve = async (request, signal) => {
    await validation.promise;
    return resolve(request, signal);
  };
  const preparing = f.service.prepare(f.request, f.controller.signal);
  const failure = new Error('synthetic cancelled validation');
  f.controller.abort(failure);
  validation.resolve();
  await expect(preparing).rejects.toBe(failure);
  expect(f.integration.execution.start).not.toHaveBeenCalled();
});

test.each(['before', 'after'] as const)('admission cancellation %s handle return aborts the exact native occurrence', async (timing) => {
  const f = fixture();
  const handleReady = Promise.withResolvers<AgentExecutionHandle>();
  const abortReceived = Promise.withResolvers<void>();
  f.integration.execution.start.mockImplementation(() => handleReady.promise);
  f.integration.execution.abort.mockImplementation(async () => { abortReceived.resolve(); return true; });
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  const pending = f.service.dispatch(prepared, f.input, f.delivery);
  if (timing === 'after') { handleReady.resolve(f.nativeHandle); await pending; }
  f.controller.abort(new Error('synthetic Stop'));
  handleReady.resolve(f.nativeHandle);
  await pending;
  await abortReceived.promise;
  expect(f.integration.execution.abort).toHaveBeenCalledTimes(1);
  expect(f.integration.execution.abort).toHaveBeenCalledWith(f.nativeHandle);
});

test('cancellation while launch returns stops only its captured native handle and execution facet', async () => {
  const f = fixture();
  const result = Promise.withResolvers<AgentExecutionHandle>();
  const original = f.integration.execution;
  original.start.mockImplementation(() => result.promise);
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  const pending = f.service.dispatch(prepared, f.input, f.delivery);
  const aborted = f.service.abort(prepared);
  const repeatedAbort = f.service.abort(prepared);
  expect(original.start.mock.calls[0]![0].admission.signal.aborted).toBe(true);
  const replacement = fixture().integration.execution;
  f.integration.execution = replacement;
  result.resolve(f.nativeHandle);
  await pending;
  expect(await Promise.all([aborted, repeatedAbort])).toEqual([true, true]);
  expect(original.abort).toHaveBeenCalledTimes(1);
  expect(original.abort).toHaveBeenCalledWith(f.nativeHandle);
  expect(replacement.abort).not.toHaveBeenCalled();
});

test('failed launch settles a pending abort without another dispatch', async () => {
  const f = fixture();
  const result = Promise.withResolvers<AgentExecutionHandle>();
  f.integration.execution.start.mockImplementation(() => result.promise);
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  const pending = f.service.dispatch(prepared, f.input, f.delivery);
  const observed = pending.catch((error: unknown) => error);
  const aborted = f.service.abort(prepared);
  const failure = new Error('synthetic failed launch');
  result.reject(failure);
  expect(await observed).toBe(failure);
  expect(await aborted).toBe(false);
  expect(f.integration.execution.abort).not.toHaveBeenCalled();
});

test('checks cancellation again after asynchronous admission and preserves inline publication', async () => {
  const f = fixture();
  const admission = Promise.withResolvers<void>();
  f.delivery.admission.markStarted.mockImplementation(() => admission.promise);
  const sent = mock(() => {});
  f.integration.execution.start.mockImplementation(async (request) => {
    request.output.emit({ type: 'notice', runId: request.runId, content: 'synthetic preflight notice' });
    await request.admission.markStarted();
    sent();
    return f.nativeHandle;
  });
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  const pending = f.service.dispatch(prepared, f.input, f.delivery);
  const observed = pending.catch((error: unknown) => error);
  expect(f.events).toEqual([{ type: 'notice', runId: 'synthetic-run', content: 'synthetic preflight notice' }]);
  const aborted = f.service.abort(prepared);
  admission.resolve();
  expect(await observed).toMatchObject({ name: 'AbortError' });
  expect(await aborted).toBe(false);
  expect(sent).not.toHaveBeenCalled();
});

test.each(['resume', 'compact'] as const)('%s uses the selected native binding without carried context', async (kind) => {
  const f = fixture();
  const request: ProviderExecutionRequest = {
    ...f.request, kind, agentSessionId: 'synthetic-native-session', nativeSession: null,
  };
  const prepared = await f.service.prepare(request, f.controller.signal);
  await f.service.dispatch(prepared, f.input, f.delivery);
  const facet = kind === 'resume' ? f.integration.execution.resume : f.integration.compaction.compact;
  expect(facet.mock.calls[0]![0]).toMatchObject({ agentSessionId: 'synthetic-native-session', nativeSession: null });
  expect(facet.mock.calls[0]![0]).not.toHaveProperty('carriedContext');
  expect(await f.service.abort(prepared)).toBe(true);
  expect(f.integration.execution.abort).toHaveBeenCalledWith(f.nativeHandle);
  expect(f.integration.execution.start).not.toHaveBeenCalled();
});

test('rejects unsupported compaction during preparation', async () => {
  const f = fixture();
  const service = new LocalProviderExecutionService({ ...f.integration, compaction: null }, f.configuration);
  await expect(service.prepare({ ...f.request,
    kind: 'compact', agentSessionId: 'synthetic-native-session', nativeSession: null,
  }, f.controller.signal)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  expect(f.integration.settings.parse).not.toHaveBeenCalled();
});

test.each(['resume', 'compact'] as const)('%s rejects carried context before native mutation', async (kind) => {
  const f = fixture();
  const prepared = await f.service.prepare({
    ...f.request, kind, agentSessionId: 'synthetic-native-session', nativeSession: null,
  }, f.controller.signal);
  await expect(f.service.dispatch(prepared, {
    ...f.input, carriedContext: { prefix: 'synthetic carried context' },
  }, f.delivery)).rejects.toThrow('Only a new native session accepts carried context');
  expect(f.integration.execution.resume).not.toHaveBeenCalled();
  expect(f.integration.compaction.compact).not.toHaveBeenCalled();
});

async function runningFixture() {
  const f = fixture();
  const prepared = await f.service.prepare({
    ...f.request, kind: 'resume', agentSessionId: 'synthetic-session', nativeSession: null,
  }, f.controller.signal);
  await f.service.dispatch(prepared, f.input, f.delivery);
  return { ...f, prepared, published: f.integration.execution.resume.mock.calls[0]![0].output };
}

test('steering rejects targets from another occurrence or instance even when native sessions collide', async () => {
  const f = await runningFixture();
  const other = await runningFixture();
  const prepared = await f.service.prepareSteer(f.prepared, f.controller.signal);
  if (prepared.kind !== 'ready') throw new Error('Synthetic steering target missing');
  const { target } = prepared;
  const input = { input: 'synthetic steer', clientMessageId: 'synthetic-steer', prepareDelivery: mock(async () => {}) };
  await expect(other.service.steer(other.prepared, target, input)).rejects.toThrow('target is invalid');
  const replacement = await f.service.prepare({
    ...f.request, kind: 'resume', agentSessionId: 'synthetic-session', nativeSession: null,
  }, f.controller.signal);
  await f.service.dispatch(replacement, f.input, f.delivery);
  await expect(f.service.steer(replacement, target, input)).rejects.toThrow('target is invalid');
  await expect(f.service.steer(f.prepared, target, input)).resolves.toEqual({ kind: 'accepted' });
  expect(input.prepareDelivery).toHaveBeenCalledOnce();
  await expect(f.service.steer(f.prepared, target, input)).rejects.toThrow('target is invalid');
  expect(other.integration.steering.steer).not.toHaveBeenCalled();
});

test('a terminal between steering preparation and delivery prevents admission', async () => {
  const f = await runningFixture();
  const prepared = await f.service.prepareSteer(f.prepared, f.controller.signal);
  if (prepared.kind !== 'ready') throw new Error('Synthetic steering target missing');
  const { target } = prepared;
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  const prepareDelivery = mock(async () => {});
  expect(await f.service.steer(f.prepared, target, { input: 'synthetic steer', clientMessageId: 'synthetic-steer', prepareDelivery }))
    .toMatchObject({ kind: 'rejected', reason: 'turn-changed' });
  expect(prepareDelivery).not.toHaveBeenCalled();
  expect(f.integration.steering.steer).not.toHaveBeenCalled();
});

test('start publication makes the exact native session available before its handle returns', async () => {
  const f = fixture();
  const handleReady = Promise.withResolvers<AgentExecutionHandle>();
  f.integration.execution.start.mockImplementation(async (request) => {
    request.output.emit({ type: 'session', session: {
      agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null,
    } });
    return handleReady.promise;
  });
  const prepared = await f.service.prepare(f.request, f.controller.signal);
  const pending = f.service.dispatch(prepared, f.input, f.delivery);
  expect(await f.service.prepareSteer(prepared, f.controller.signal)).toMatchObject({ kind: 'ready' });
  expect(f.integration.steering.captureTarget).toHaveBeenCalledWith({
    chatId: 'synthetic-chat', agentSessionId: 'synthetic-session', nativeSession: null,
  });
  handleReady.resolve(f.nativeHandle);
  await pending;
});

test('goal handoffs retain the occurrence output, admission and abort handle through repeated run changes', async () => {
  const f = await runningFixture();
  for (const runId of ['goal-run-1', 'goal-run-2']) {
    expect(await f.service.submitGoalControl(f.prepared, {
      ...f.input, runId, configuration: f.request.configuration,
      beforeDelivery: async (handoff) => { handoff.validate(); handoff.commit(); },
    }, f.controller.signal)).toBe(true);
    const request = f.integration.goals.submitControl.mock.calls.at(-1)![0];
    expect(request.output).toBe(f.published);
    expect(request.admission).toBe(f.integration.execution.resume.mock.calls[0]![0].admission);
  }
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  expect(await f.service.prepareSteer(f.prepared, f.controller.signal)).toMatchObject({ kind: 'ready' });
  expect(await f.service.abort(f.prepared)).toBe(true);
  expect(f.integration.execution.abort).toHaveBeenCalledWith(f.nativeHandle);
  expect(f.integration.execution.resume).toHaveBeenCalledOnce();
});

test('matching terminal detaches admission cancellation while retaining inline late output', async () => {
  const f = await runningFixture();
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  f.controller.abort(new Error('synthetic owner cleanup'));
  await Promise.resolve();
  expect(f.integration.execution.abort).not.toHaveBeenCalled();
  f.published.emit({ type: 'notice', runId: f.request.runId, content: 'synthetic late output' });
  expect(f.events.at(-1)).toMatchObject({ content: 'synthetic late output' });
});

test('a terminal during goal configuration preparation prevents the native control and handoff', async () => {
  const f = await runningFixture();
  const validating = Promise.withResolvers<void>();
  const resolve = f.configuration.resolve.bind(f.configuration);
  f.configuration.resolve = async (request, signal) => { await validating.promise; return resolve(request, signal); };
  const beforeDelivery = mock(async () => {});
  const pending = f.service.submitGoalControl(f.prepared, {
    ...f.input, runId: 'goal-run', configuration: f.request.configuration, beforeDelivery,
  }, f.controller.signal);
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  validating.resolve();
  expect(await pending).toBe(false);
  expect(f.integration.goals.submitControl).not.toHaveBeenCalled();
  expect(beforeDelivery).not.toHaveBeenCalled();
});
