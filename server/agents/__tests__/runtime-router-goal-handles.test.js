import { expect, mock, test } from 'bun:test';
import { createAgentProducerAdapter } from '@garcon/server-agent-common/execution/producer-adapter';
import { AgentEventBus } from '../event-bus.js';
import { AgentRuntimeRouter } from '../runtime-router.js';
import { createRuntimeInstanceFixture, createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

function fixture() {
  const transcript = createRuntimeTranscriptFixture();
  const events = new AgentEventBus();
  const session = { agentSessionId: 'synthetic-native', nativeSession: null, nativeSeedReceipt: null };
  const entry = {
    id: 'chat-1', agentId: 'synthetic', agentOwnershipEpoch: 'synthetic-epoch',
    model: 'synthetic-model', projectPath: '/synthetic-project', agentSessionId: null,
  };
  transcript.ledger.subscribe((event) => {
    if (event.type === 'session') Object.assign(entry, event.row.detail);
    if (event.type === 'run-ended') void events.publishRunEnded(event.chatId, event.runId, event.row);
  });
  let currentPublisher;
  const publishers = [];
  const activate = (publish) => { currentPublisher = publish; publishers.push(publish); };
  const runtime = {
    async start(_request, publish) {
      activate(publish);
      publish({ type: 'session', session });
      return session;
    },
    async resume(_request, publish) { activate(publish); },
    abort: mock(async (agentSessionId, publish) => (
      agentSessionId === session.agentSessionId && publish === currentPublisher
    )),
    runningSessions: () => [],
  };
  const adapter = createAgentProducerAdapter(runtime, { debug() {}, info() {}, warn() {}, error() {} });
  const launched = Promise.withResolvers();
  const handleReady = Promise.withResolvers();
  const delay = async (pending) => {
    const handle = await pending;
    launched.resolve();
    await handleReady.promise;
    return handle;
  };
  const execution = {
    ...adapter.execution,
    start: mock((request) => delay(adapter.execution.start(request))),
    resume: (request) => delay(adapter.execution.resume(request)),
    abort: mock(adapter.execution.abort),
  };
  const commitGoal = mock(() => {});
  const integration = {
    descriptor: {
      id: 'synthetic', supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
    },
    settings: {
      defaults: () => ({ ownerId: 'synthetic', schemaVersion: 1, values: {} }), parse: (value) => value,
    },
    execution,
    compaction: { compact: (request) => delay(adapter.compact(request, async (_request, publish) => activate(publish))) },
    goals: {
      submitControl: mock((request) => adapter.submitGoalControl(request, async (goal) => {
        await goal.beforeDelivery({ validate() {}, commit: commitGoal });
        return true;
      })),
    },
  };
  const endpointResolver = {
    resolveSelection: () => ({ model: entry.model, apiProviderId: null, endpointId: null, protocol: null }),
    resolveEndpointReference: () => null,
  };
  const router = new AgentRuntimeRouter({
    fileMentions: { resolve: async (command) => command },
    registry: { getChat: () => entry, updateChat: (_chatId, patch) => Object.assign(entry, patch) },
    instances: createRuntimeInstanceFixture(integration),
    providerIds: ['test'],
    endpointResolver,
    events, getCarryOverRevision: () => 'synthetic-revision',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    ledger: transcript.ledger, adoption: transcript.adoption, hasPendingOwnershipTransfer: () => false,
  });
  const launch = (kind) => {
    if (kind === 'start') return router.startSession('chat-1', 'synthetic input', { turnId: 'run-1' });
    Object.assign(entry, session);
    return kind === 'resume'
      ? router.runAgentTurn('chat-1', 'synthetic input', { turnId: 'run-1' })
      : router.compactSession('chat-1', { turnId: 'run-1' });
  };
  const handoff = (turnId) => router.submitGoalControl('chat-1', 'synthetic goal', { turnId }, async (handoff) => {
    handoff.validate();
    handoff.commit();
  });
  return { router, entry, endpointResolver, transcript, events, runtime, execution, integration, publishers, launched, handleReady, launch, handoff, commitGoal };
}

test.each(['run-1', 'run-2'])('all goal owners select the successor before synchronous terminal %s', async (terminalRunId) => {
  const f = fixture();
  const terminals = [];
  f.events.onFinished((_chatId, _exitCode, metadata) => { terminals.push(metadata.turnId); });
  const launching = f.launch('start');
  try {
    await f.launched.promise;
    f.commitGoal.mockImplementationOnce(() => {
      expect(f.transcript.activeRunId()).toBe('run-2');
      expect(f.events.getActiveTurn('chat-1').turnId).toBe('run-2');
      f.publishers[0]({ type: 'run-ended', runId: terminalRunId, outcome: 'finished' });
    });
    expect(await f.handoff('run-2')).toBe(true);
    if (terminalRunId === 'run-2') {
      expect(f.transcript.activeRunId()).toBeNull();
      expect(terminals).toEqual(['run-2']);
      expect(await f.handoff('run-3')).toBe(false);
    } else {
      expect(terminals).toEqual([]);
      expect(f.transcript.activeRunId()).toBe('run-2');
      expect(await f.handoff('run-3')).toBe(true);
      expect(await f.router.abortSession('chat-1')).toBe(true);
    }
  } finally {
    f.handleReady.resolve();
    await launching;
  }
});

test.each([false, true])('throwing goal commit cannot restore a predecessor after terminal=%s', async (terminal) => {
  const f = fixture();
  const launching = f.launch('start');
  try {
    await f.launched.promise;
    f.commitGoal.mockImplementationOnce(() => {
      if (terminal) f.publishers[0]({ type: 'run-ended', runId: 'run-2', outcome: 'finished' });
      throw new Error('synthetic post-transfer failure');
    });
    await expect(f.handoff('run-2')).rejects.toThrow('synthetic post-transfer failure');
    f.publishers[0]({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
    expect(f.transcript.activeRunId()).toBe(terminal ? null : 'run-2');
    if (!terminal) {
      expect(f.events.getActiveTurn('chat-1').turnId).toBe('run-2');
      expect(await f.router.abortSession('chat-1')).toBe(true);
      f.handleReady.resolve();
      await launching;
      expect(f.runtime.abort).toHaveBeenCalledWith('synthetic-native', f.publishers[0]);
    }
  } finally {
    f.handleReady.resolve();
    await launching;
  }
});

test('each goal captures fresh endpoint credentials and retains the exact operation delivery', async () => {
  const f = fixture();
  const selection = { model: f.entry.model, apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint',
    protocol: 'openai-compatible', isLocal: false };
  Object.assign(f.entry, { apiProviderId: selection.apiProviderId, modelEndpointId: selection.endpointId, modelProtocol: selection.protocol });
  let endpoint = { baseUrl: 'https://original.invalid/v1', apiKey: 'synthetic-original-key' };
  f.endpointResolver.resolveSelection = () => selection;
  f.endpointResolver.resolveEndpointReference = mock(() => ({ apiProvider: { label: 'Synthetic API' }, endpoint }));
  f.integration.endpoints = { validate: mock(async () => {}) };
  const launching = f.launch('start');
  try {
    await f.launched.promise;
    const start = f.execution.start.mock.calls[0][0];
    expect(start.endpoint).toMatchObject({
      selection: { baseUrl: 'https://original.invalid/v1' }, credential: 'synthetic-original-key',
    });
    endpoint = { baseUrl: 'https://updated.invalid/v1', apiKey: 'synthetic-updated-key' };
    const validation = Promise.withResolvers();
    const entered = Promise.withResolvers();
    f.integration.endpoints.validate.mockImplementationOnce(() => { entered.resolve(); return validation.promise; });
    const pending = f.handoff('run-2');
    await entered.promise;
    endpoint = { baseUrl: 'https://latest.invalid/v1', apiKey: 'synthetic-latest-key' };
    validation.resolve();
    expect(await pending).toBe(true);
    expect(await f.handoff('run-3')).toBe(true);
    const goals = f.integration.goals.submitControl.mock.calls.map(([request]) => request);
    expect(goals.map((request) => [request.endpoint.selection.baseUrl, request.endpoint.credential])).toEqual([
      ['https://updated.invalid/v1', 'synthetic-updated-key'],
      ['https://latest.invalid/v1', 'synthetic-latest-key'],
    ]);
    for (const request of goals) {
      expect(request.output).toBe(start.output);
      expect(request.admission).toBe(start.admission);
      expect(request.agentSessionId).toBe('synthetic-native');
    }
    expect(f.execution.start).toHaveBeenCalledOnce();
    expect(f.endpointResolver.resolveEndpointReference).toHaveBeenCalledTimes(3);
    expect(f.transcript.activeRunId()).toBe('run-3');
  } finally {
    f.handleReady.resolve();
    await launching;
  }
});

for (const kind of ['start', 'resume', 'compact']) {
  test.each(['before', 'after'])(`${kind} preserves cancellation through goal handoffs when Stop is %s handle return`, async (timing) => {
    const f = fixture();
    const launching = f.launch(kind);
    await f.launched.promise;
    expect(await f.handoff('run-2')).toBe(true);
    expect(await f.handoff('run-3')).toBe(true);
    f.publishers[0]({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
    expect(f.transcript.activeRunId()).toBe('run-3');
    if (timing === 'after') { f.handleReady.resolve(); await launching; }
    expect(await f.router.abortSession('chat-1')).toBe(true);
    expect(f.transcript.activeRunId()).toBeNull();
    f.handleReady.resolve();
    await launching;
    expect(f.runtime.abort).toHaveBeenCalledTimes(1);
    expect(f.runtime.abort).toHaveBeenCalledWith('synthetic-native', f.publishers[0]);
    expect(await f.router.abortSession('chat-1')).toBe(false);
  });

  test(`${kind} launch failure settles the run selected by a committed goal handoff`, async () => {
    const f = fixture();
    const launching = f.launch(kind);
    const observed = launching.catch((error) => error);
    await f.launched.promise;
    expect(await f.handoff('run-2')).toBe(true);
    const failure = new Error('synthetic handle failure');
    f.handleReady.reject(failure);
    expect(await observed).toBe(failure);
    expect(f.transcript.activeRunId()).toBeNull();
    expect(f.runtime.abort).not.toHaveBeenCalled();
  });
}

test.each(['interrupted', 'finished'])('%s goal launch returning late cannot replace a successor handle', async (outcome) => {
  const f = fixture();
  const launching = f.launch('start');
  await f.launched.promise;
  expect(await f.handoff('run-2')).toBe(true);
  if (outcome === 'interrupted') await f.router.abortSession('chat-1');
  else f.publishers[0]({ type: 'run-ended', runId: 'run-2', outcome });
  const successor = Object.freeze({});
  f.integration.execution = {
    ...f.execution,
    resume: async () => successor,
    abort: mock(async () => true),
  };
  await f.router.runAgentTurn('chat-1', 'synthetic successor', { turnId: 'run-3' });
  f.handleReady.resolve();
  await launching;
  expect(f.execution.abort).toHaveBeenCalledTimes(outcome === 'interrupted' ? 1 : 0);
  expect(f.transcript.activeRunId()).toBe('run-3');
  expect(await f.router.abortSession('chat-1')).toBe(true);
  expect(f.integration.execution.abort).toHaveBeenCalledWith(successor);
});
