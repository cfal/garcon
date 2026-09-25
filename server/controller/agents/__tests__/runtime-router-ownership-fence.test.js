import { resolveFileMentionsInCommand } from "../../../runtime/projects/file-mentions.ts";
import { describe, expect, it, mock } from 'bun:test';
import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';
import { createProducerFixture } from './producer-fixture.ts';
import { AgentCallError } from '@garcon/server-agent-interface';
import { DomainError } from '../../../common/domain-error.ts';

function makeRouter(hasPendingOwnershipTransfer) {
  const producer = createProducerFixture();
  const transcript = createRuntimeTranscriptFixture();
  const execution = {
    start: mock(async () => producer.reference('execution')),
    resume: mock(async () => producer.reference('execution')),
    abort: mock(async () => true),
    runningSessions: mock(() => []),
  };
  const entry = {
    agentId: 'test',
    model: 'model-a',
    projectPath: '/workspace',
    agentSessionId: 'session-a',
    agentOwnershipEpoch: 'epoch-1',
  };
  const integration = {
    descriptor: {
      id: 'test',
      supportedEndpointProtocols: [],
      supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'],
    },
    settings: { parse: (value) => value ?? {}, defaults: () => ({}) },
    execution,
    compaction: { compact: mock(async () => producer.reference('execution')) },
    producers: producer.producers,
    forking: null,
  };
  const createCarriedContext = mock(async () => ({ kind: 'no-history' }));
  const resolveFileMentions = mock(resolveFileMentionsInCommand);
  const adoption = { ensure: mock(transcript.adoption.ensure) };
  const endpointResolver = {
    resolveSelection: mock(() => ({ model: 'model-a', apiProviderId: null, endpointId: null, protocol: null, isLocal: false })),
    resolveEndpointReference: mock(() => null),
    describePrevious(input) { return this.resolveSelection(input); },
  };
  const router = new AgentRuntimeRouter({
    resolveFileMentions,
    registry: {
      getChat: mock(() => entry),
      updateChat: mock(async () => entry),
    },
    directory: {
      require: mock(() => integration),
      list: mock(() => [integration]),
    },
    endpointResolver,
    events: { trackTurn: mock(() => undefined), clearTurn: mock(() => undefined) },
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext,
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer,
    adoption,
  });
  return { router, execution, transcript, producer, integration, entry, createCarriedContext, resolveFileMentions, adoption, endpointResolver };
}

describe('AgentRuntimeRouter ownership fence', () => {
  const launches = [
    ['start', 'startSession'],
    ['resume', 'runAgentTurn'],
    ['compact', 'compactSession'],
  ];
  const launch = (router, method, opts) => method === 'compactSession'
    ? router.compactSession('chat-1', opts)
    : router[method]('chat-1', 'hello', opts);

  it.each(launches)('rechecks provider policy after asynchronous preparation before %s dispatch', async (_operation, method) => {
    const { router, execution, integration, producer, endpointResolver } = makeRouter(() => false);
    const bind = producer.producers.bind;
    let revoked = false;
    producer.producers.bind = mock(async (...args) => { const binding = await bind(...args); revoked = true; return binding; });
    endpointResolver.resolveEndpointReference.mockImplementation(() => {
      if (revoked) throw new DomainError('API_PROVIDER_UNAVAILABLE', 'Synthetic revoked assignment', 409);
      return null;
    });
    await expect(launch(router, method, { turnId: 'turn-1' })).rejects.toMatchObject({ code: 'API_PROVIDER_UNAVAILABLE' });
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
    expect(integration.compaction.compact).not.toHaveBeenCalled();
    expect(router.isChatRunning('chat-1')).toBe(false);
  });

  it.each(launches)('settles an unknown producer-binding failure before %s dispatch', async (_operation, method) => {
    const { router, execution, transcript, producer, integration } = makeRouter(() => false);
    const events = [];
    transcript.ledger.subscribe((event) => events.push(event));
    const bind = producer.producers.bind;
    producer.producers.bind = mock(async () => { throw new AgentCallError('unknown', 'Lost binding reply'); });
    const markStarted = mock(async () => {});
    await expect(launch(router, method, {
      turnId: 'turn-1',
      executionAdmission: { signal: new AbortController().signal, markStarted },
    })).rejects.toMatchObject({ outcome: 'not-dispatched', code: 'UNAVAILABLE' });
    expect(router.isChatRunning('chat-1')).toBe(false);
    expect(events).toMatchObject([{
      type: 'run-ended', runId: 'turn-1', row: { origin: 'core', outcome: 'failed', error: { code: 'UNAVAILABLE' } },
    }]);
    expect(execution.start).not.toHaveBeenCalled();
    expect(execution.resume).not.toHaveBeenCalled();
    expect(integration.compaction.compact).not.toHaveBeenCalled();

    producer.producers.bind = bind;
    await router.runAgentTurn('chat-1', 'next', { turnId: 'turn-2' });
    const request = execution.resume.mock.calls[0][0];
    producer.emit(request.producerBinding, { type: 'started', runId: 'turn-1' });
    expect(markStarted).not.toHaveBeenCalled();
    expect(transcript.activeRunId()).toBe('turn-2');
  });

  it.each(['startSession', 'runAgentTurn'])('settles an unknown carryover failure before %s dispatch', async (method) => {
    const { router, execution, transcript, entry, createCarriedContext } = makeRouter(() => false);
    entry.agentSessionId = null;
    const events = [];
    transcript.ledger.subscribe((event) => events.push(event));
    createCarriedContext.mockImplementation(async () => { throw new AgentCallError('unknown', 'Lost summary reply'); });
    await expect(launch(router, method, { turnId: 'turn-1' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(router.isChatRunning('chat-1')).toBe(false);
    expect(events).toMatchObject([{ type: 'run-ended', runId: 'turn-1', row: { outcome: 'failed' } }]);
    expect(execution.start).not.toHaveBeenCalled();
  });

  for (const method of ['startSession', 'runAgentTurn']) {
    it.each(['adoption', 'file mentions'])('classifies unknown %s failure before a run exists in ' + method, async (phase) => {
      const { router, execution, transcript, adoption, resolveFileMentions } = makeRouter(() => false);
      const events = [];
      transcript.ledger.subscribe((event) => events.push(event));
      const setup = phase === 'adoption' ? adoption.ensure : resolveFileMentions;
      setup.mockImplementation(async () => { throw new AgentCallError('unknown', 'Lost setup reply'); });
      await expect(launch(router, method, { turnId: 'turn-1' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      expect(router.isChatRunning('chat-1')).toBe(false);
      expect(events).toEqual([]);
      expect(execution.start).not.toHaveBeenCalled();
      expect(execution.resume).not.toHaveBeenCalled();
    });
  }

  it.each(launches)('retains an uncertain %s until session loss and publishes failure before closing its lease', async (operation, method) => {
    const { router, execution, transcript, integration } = makeRouter(() => false);
    const events = [];
    transcript.ledger.subscribe((event) => events.push(event));
    const invoke = operation === 'compact' ? integration.compaction.compact : execution[operation];
    invoke.mockImplementation(async () => { throw new AgentCallError('unknown', 'Lost reply'); });
    await expect(launch(router, method, { turnId: 'turn-1' })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(router.isChatRunning('chat-1')).toBe(true);
    expect(events).toEqual([]);
    const oldSink = transcript.sink;
    router.executionSessionLost();
    expect(router.isChatRunning('chat-1')).toBe(false);
    expect(events).toMatchObject([{
      type: 'run-ended', runId: 'turn-1', row: { origin: 'core', outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN' } },
    }]);
    expect(() => oldSink.publish({ type: 'run-ended', runId: 'turn-1', outcome: 'finished' })).toThrow('closed');
    router.executionSessionLost();
    expect(events).toHaveLength(1);
  });

  it('preserves an unknown start outcome when runAgentTurn delegates to startSession', async () => {
    const { router, execution, entry } = makeRouter(() => false);
    entry.agentSessionId = null;
    execution.start.mockImplementation(async () => { throw new AgentCallError('unknown', 'Lost start reply'); });
    await expect(router.runAgentTurn('chat-1', 'hello', { turnId: 'turn-1' })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(router.isChatRunning('chat-1')).toBe(true);
  });

  it('fences a start reply and producer event arriving after terminal session loss', async () => {
    const { router, execution, transcript, producer } = makeRouter(() => false);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    execution.resume.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const turn = router.runAgentTurn('chat-1', 'hello', { turnId: 'turn-1' });
    await entered.promise;
    const request = execution.resume.mock.calls[0][0];
    router.executionSessionLost();
    release.resolve(producer.reference('execution'));
    await turn;
    await router.runAgentTurn('chat-1', 'next', { turnId: 'turn-2' });
    producer.emit(request.producerBinding, { type: 'run-ended', runId: 'turn-2', outcome: 'finished' });
    expect(transcript.activeRunId()).toBe('turn-2');
    expect(execution.resume).toHaveBeenCalledTimes(2);
  });

  it('[TLV5-HANDOFF.02-CORE-UNIT-01] refuses to publish while a decided handoff has not rolled forward', async () => {
    const { router, execution } = makeRouter(() => true);

    await expect(router.runAgentTurn('chat-1', 'hello', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });
    expect(execution.resume).not.toHaveBeenCalled();
  });

  it('[TLV5-HANDOFF.04-CORE-UNIT-01] resumes publishing once roll-forward discharges the decision', async () => {
    let pending = true;
    const { router, execution } = makeRouter(() => pending);

    await expect(router.runAgentTurn('chat-1', 'hello', {
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });

    pending = false;
    await router.runAgentTurn('chat-1', 'hello', {
      clientRequestId: 'request-2',
      clientMessageId: 'message-2',
      turnId: 'turn-2',
    });

    expect(execution.resume).toHaveBeenCalledTimes(1);
  });
});
