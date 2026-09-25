import { describe, expect, it, mock } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
} from '@garcon/common/chat-types';
import type {
  AgentLogger,
  AgentProducerEvent,
  AgentProducerSink,
  AgentStartRequestV5,
} from '@garcon/server-agent-interface';
import {
  runtimeRows,
  type AgentRuntimeEvent,
  type AgentRuntimeExecution,
  type AgentRuntimePublisher,
} from '../runtime-events.js';
import { createAgentProducerAdapter } from '../producer-adapter.js';
import { createAgentResourceRef } from '@garcon/server-agent-interface';

const TS = '2026-08-12T00:00:00.000Z';
const scope = { executorId: 'test-node', instanceId: 'test-runtime', integrationId: 'test' };

describe('createAgentProducerAdapter', () => {
  it('publishes sessions, normalized rows, and terminal events through the supplied sink', async () => {
    const fixture = await createFixture();
    const handle = await fixture.adapter.execution.start(fixture.request);

    expect(fixture.events.map((event) => event.type)).toEqual([
      'session',
      'rows',
      'run-ended',
    ]);
    expect(fixture.events[1]).toMatchObject({
      type: 'rows',
      rows: [{
        message: { type: 'assistant-message', content: 'answer' },
      }],
    });
    expect(fixture.events[2]).toEqual({
      type: 'run-ended',
      runId: 'run-1',
      outcome: 'finished',
    });
    await expect(fixture.adapter.execution.abort(handle)).rejects.toThrow('retired');
  });

  it('forwards typed permission lifecycle events without interpreting chat rows', async () => {
    const decision = permissionDecision('occurrence-1');
    const fixture = await createFixture(({ publish, runId }) => {
      const tool = new BashToolUseMessage(TS, 'tool-1', 'pwd');
      publish({
        type: 'rows',
        rows: runtimeRows([new AssistantMessage(TS, 'before')]),
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionRequest('occurrence-1', tool),
        decision,
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionCancellation('occurrence-1'),
      });
      publish({
        type: 'rows',
        rows: runtimeRows([new AssistantMessage(TS, 'after')]),
      });
    });

    await fixture.adapter.execution.start(fixture.request);

    expect(fixture.events.map((event) => event.type)).toEqual([
      'session',
      'rows',
      'permission',
      'permission',
      'rows',
    ]);
    const requested = fixture.events[2];
    const cancelled = fixture.events[3];
    expect(requested).toMatchObject({
      type: 'permission',
      runId: 'run-1',
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId: 'occurrence-1',
      },
      decision: { permissionOccurrenceId: 'occurrence-1', response: expect.objectContaining({ kind: 'permission-response' }) },
    });
    expect(cancelled).toMatchObject({
      type: 'permission',
      runId: 'run-1',
      lifecycle: {
        kind: 'cancelled',
        permissionOccurrenceId: 'occurrence-1',
        reason: 'aborted',
      },
    });
  });

  it('[TLV5-PERM.02-ADAPTER-UNIT-01] preserves each exact permission occurrence', async () => {
    const firstDecision = permissionDecision('first-occurrence');
    const secondDecision = permissionDecision('second-occurrence');
    const fixture = await createFixture(({ publish, runId }) => {
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionRequest(
          'first-occurrence',
          new BashToolUseMessage(TS, 'tool-1', 'first'),
        ),
        decision: firstDecision,
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionRequest(
          'second-occurrence',
          new BashToolUseMessage(TS, 'tool-2', 'second'),
        ),
        decision: secondDecision,
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionCancellation('first-occurrence'),
      });
    });

    await fixture.adapter.execution.start(fixture.request);

    expect(fixture.events.flatMap((event) => (
      event.type === 'permission' ? [event.lifecycle.permissionOccurrenceId] : []
    ))).toEqual([
      'first-occurrence',
      'second-occurrence',
      'first-occurrence',
    ]);
    expect(fixture.events[1]).toMatchObject({ decision: { permissionOccurrenceId: firstDecision.permissionOccurrenceId } });
    expect(fixture.events[2]).toMatchObject({ decision: { permissionOccurrenceId: secondDecision.permissionOccurrenceId } });
    expect(fixture.events[1].decision.response.id).not.toBe(fixture.events[2].decision.response.id);
  });

  it('[TLV5-PERM.09-ADAPTER-UNIT-01] drops an unnamed permission event with one content-free warning', async () => {
    const decision = permissionDecision('occurrence-1');
    const fixture = await createFixture(({ publish }) => {
      publish({
        type: 'permission',
        runId: null,
        lifecycle: permissionRequest(
          'occurrence-1',
          new BashToolUseMessage(TS, 'tool-1', 'sensitive-command-must-not-be-logged'),
        ),
        decision,
      } as unknown as AgentRuntimeEvent);
    });

    await fixture.adapter.execution.start(fixture.request);

    expect(fixture.events.map((event) => event.type)).toEqual(['session']);
    expect(fixture.warnings).toEqual([{
      message: 'Dropped an unnamed provider permission event',
      fields: {
        chatId: 'chat-1',
        eventType: 'permission',
        reason: expect.any(String),
      },
    }]);
    expect(JSON.stringify(fixture.warnings)).not.toContain('permission-1');
    expect(JSON.stringify(fixture.warnings)).not.toContain('sensitive-command-must-not-be-logged');
    expect(JSON.stringify(fixture.events)).not.toContain('permission-1');
    expect(JSON.stringify(fixture.events)).not.toContain('sensitive-command-must-not-be-logged');
  });

  it('[TLV5-L07.08-ADAPTER-UNIT-01] drops provider events for an unavailable sink without failing its event stream', async () => {
    const fixture = await createFixture(({ publish }) => {
      fixture.closeSink();
      publish({
        type: 'rows',
        rows: runtimeRows([new AssistantMessage(TS, 'after close')]),
      });
      publish({
        type: 'run-ended',
        runId: 'run-1',
        outcome: 'finished',
      });
    });

    await fixture.adapter.execution.start(fixture.request);

    expect(fixture.events.map((event) => event.type)).toEqual(['session']);
    expect(fixture.warnings).toHaveLength(2);
  });

  it('leaves dispatch failures for core to record', async () => {
    const fixture = await createFixture(undefined, new Error('launch failed'));

    await expect(fixture.adapter.execution.start(fixture.request)).rejects.toThrow('launch failed');
    expect(fixture.events).toEqual([]);
  });

  it.each([false, true])('aborts a closed binding during pending startup (session published: %s)', async (published) => {
    const fixture = await createFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const session = { agentSessionId: 'closed-session', nativeSession: null, nativeSeedReceipt: null };
    let admissionSignal: AbortSignal | undefined;
    fixture.runtime.start = async (request, publish) => {
      admissionSignal = request.admission.signal;
      if (published) publish({ type: 'session', session });
      started.resolve();
      await release.promise;
      return session;
    };
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    const starting = fixture.adapter.execution.start(fixture.request);
    await started.promise;
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    expect(admissionSignal?.aborted).toBe(true);
    expect(abort).toHaveBeenCalledTimes(published ? 1 : 0);
    release.resolve();
    await expect(starting).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenLastCalledWith('closed-session');
    expect(fixture.events).toHaveLength(published ? 1 : 0);
  });

  it.each([false, true])('normalizes cancelled startup after binding closure (session published: %s)', async (published) => {
    const fixture = await createFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const session = { agentSessionId: 'cancelled-session', nativeSession: null, nativeSeedReceipt: null };
    fixture.runtime.start = async (request, publish) => {
      if (published) publish({ type: 'session', session });
      started.resolve();
      await release.promise;
      request.admission.signal.throwIfAborted();
      return session;
    };
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    const starting = fixture.adapter.execution.start(fixture.request);
    await started.promise;
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    release.resolve();
    await expect(starting).rejects.toMatchObject({ outcome: 'rejected', code: 'STALE_RESOURCE' });
    expect(abort).toHaveBeenCalledTimes(published ? 1 : 0);
    if (published) expect(abort).toHaveBeenCalledWith('cancelled-session');
  });

  it('preserves caller cancellation when the producer binding remains open', async () => {
    const fixture = await createFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    fixture.runtime.start = async (request) => {
      started.resolve();
      await release.promise;
      request.admission.signal.throwIfAborted();
      return { agentSessionId: 'cancelled-session', nativeSession: null, nativeSeedReceipt: null };
    };
    const starting = fixture.adapter.execution.start(fixture.request, { signal: cancellation.signal });
    await started.promise;
    cancellation.abort();
    release.resolve();
    await expect(starting).rejects.toBe(cancellation.signal.reason);
    await fixture.adapter.producers.close(fixture.request.producerBinding);
  });

  it('aborts the active operation before retiring its binding', async () => {
    const fixture = await createFixture(() => {});
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    const handle = await fixture.adapter.execution.start(fixture.request);
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    expect(abort).toHaveBeenCalledWith('session-1');
    await expect(fixture.adapter.execution.abort(handle)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
  });

  it('detaches output without aborting and rejects new work until native completion', async () => {
    let publish!: AgentRuntimePublisher;
    const fixture = await createFixture((event) => { publish = event.publish; });
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    await fixture.adapter.execution.start(fixture.request);
    const before = [...fixture.events];
    fixture.adapter.producers.detach(fixture.request.producerBinding);
    publish({ type: 'rows', rows: runtimeRows([new AssistantMessage(TS, 'detached output')]) });
    const replacement = createAgentResourceRef(scope, 'producer');
    await fixture.adapter.producers.bind({ binding: replacement, chatId: fixture.request.chatId });
    const next = { ...fixture.request, producerBinding: replacement, runId: 'next' };
    await expect(fixture.adapter.execution.start(next)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await expect(fixture.adapter.execution.resume({ ...next, agentSessionId: 'session-1', nativeSession: null }))
      .rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await expect(fixture.adapter.runExisting({ ...next, agentSessionId: 'session-1', nativeSession: null }, async () => undefined))
      .rejects.toMatchObject({ code: 'SESSION_BUSY' });
    publish({ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' });
    expect(fixture.events).toEqual(before);
    expect(abort).not.toHaveBeenCalled();
    await expect(fixture.adapter.execution.start(fixture.request)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(() => fixture.adapter.producers.detach(fixture.request.producerBinding)).not.toThrow();
    await fixture.adapter.execution.start(next);
  });

  it('denies pending and future detached permissions without publishing them', async () => {
    let publish!: AgentRuntimePublisher;
    const fixture = await createFixture((event) => { publish = event.publish; });
    await fixture.adapter.execution.start(fixture.request);
    const decisions = [mock(async () => {}), mock(async () => {})];
    const requestPermission = (index: number) => publish({
      type: 'permission', runId: fixture.request.runId,
      lifecycle: permissionRequest(`permission-${index}`, new BashToolUseMessage(TS, `tool-${index}`, 'pwd')),
      decision: { permissionOccurrenceId: `permission-${index}`, respond: decisions[index]! },
    });
    requestPermission(0);
    const permission = fixture.events.at(-1);
    fixture.adapter.producers.detach(fixture.request.producerBinding);
    requestPermission(1);
    await Promise.resolve();
    for (const respond of decisions) expect(respond).toHaveBeenCalledWith({ allow: false });
    expect(fixture.events.filter(event => event.type === 'permission')).toHaveLength(1);
    if (permission?.type !== 'permission' || !permission.decision) throw new Error('Expected permission');
    await expect(fixture.adapter.permissions.respond({ response: permission.decision.response, decision: { allow: true } }))
      .rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    publish({ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' });
  });

  it('immediately releases an idle detached binding', async () => {
    const fixture = await createFixture();
    fixture.adapter.producers.detach(fixture.request.producerBinding);
    await expect(fixture.adapter.execution.start(fixture.request)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
  });

  it('aborts a session published after closure without waiting for startup to return', async () => {
    const fixture = await createFixture();
    const started = Promise.withResolvers<AgentRuntimePublisher>();
    const release = Promise.withResolvers<void>();
    const session = { agentSessionId: 'late-session', nativeSession: null, nativeSeedReceipt: null };
    fixture.runtime.start = async (_request, publish) => {
      started.resolve(publish);
      await release.promise;
      return session;
    };
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    const starting = fixture.adapter.execution.start(fixture.request);
    const publish = await started.promise;
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    publish({ type: 'session', session });
    expect(abort).toHaveBeenCalledWith('late-session');
    expect(fixture.events).toEqual([]);
    release.resolve();
    await expect(starting).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('keeps a binding closed when best-effort native abort fails', async () => {
    const fixture = await createFixture(() => {});
    fixture.runtime.abort = async () => { throw new Error('Synthetic native abort failure'); };
    const handle = await fixture.adapter.execution.start(fixture.request);
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    await expect(fixture.adapter.execution.abort(handle)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(fixture.warnings).toEqual([{
      message: 'Failed to abort execution for a closed producer binding',
      fields: { chatId: fixture.request.chatId, reason: 'Synthetic native abort failure' },
    }]);
  });

  it('does not abort a completed operation on binding closure', async () => {
    const fixture = await createFixture();
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    await fixture.adapter.execution.start(fixture.request);
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not abort a replacement when a closed pending start settles with its session', async () => {
    const fixture = await createFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.runtime.start = async () => {
      started.resolve();
      await release.promise;
      return { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null };
    };
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    const starting = fixture.adapter.execution.start(fixture.request);
    await started.promise;
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    const replacement = createAgentResourceRef(scope, 'producer');
    await fixture.adapter.producers.bind({ binding: replacement, chatId: fixture.request.chatId });
    const handle = await fixture.adapter.execution.resume({
      ...fixture.request, runId: 'replacement', producerBinding: replacement,
      agentSessionId: 'session-1', nativeSession: null,
    });
    release.resolve();
    await expect(starting).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(abort).not.toHaveBeenCalled();
    await expect(fixture.adapter.execution.abort(handle)).resolves.toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('aborts a closed startup even while a replacement startup has no session yet', async () => {
    const fixture = await createFixture();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    fixture.runtime.start = async (request) => {
      const index = request.runId === fixture.request.runId ? 0 : 1;
      entered[index]!.resolve();
      await release[index]!.promise;
      return { agentSessionId: `session-${index}`, nativeSession: null, nativeSeedReceipt: null };
    };
    const abort = mock(async () => true);
    fixture.runtime.abort = abort;
    const starting = fixture.adapter.execution.start(fixture.request);
    await entered[0]!.promise;
    await fixture.adapter.producers.close(fixture.request.producerBinding);
    const replacement = createAgentResourceRef(scope, 'producer');
    await fixture.adapter.producers.bind({ binding: replacement, chatId: fixture.request.chatId });
    const replacing = fixture.adapter.execution.start({
      ...fixture.request, runId: 'replacement', producerBinding: replacement,
    });
    await entered[1]!.promise;
    release[0]!.resolve();
    await expect(starting).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenLastCalledWith('session-0');
    release[1]!.resolve();
    const handle = await replacing;
    await expect(fixture.adapter.execution.abort(handle)).resolves.toBe(true);
    expect(abort).toHaveBeenLastCalledWith('session-1');
  });

  it('retains late-row bindings without spending completed execution slots', async () => {
    let publishLateRows = () => { throw new Error('First publisher was not captured'); };
    const fixture = await createFixture(({ publish, runId }) => {
      if (runId === 'run-0') {
        publishLateRows = () => publish({ type: 'rows', rows: runtimeRows([new AssistantMessage(TS, 'late first-chat output')]) });
      }
      publish({ type: 'run-ended', runId, outcome: 'finished' });
    });
    for (let index = 0; index < 4097; index++) {
      const chatId = `chat-${index + 1}`;
      const producerBinding = index === 0 ? fixture.request.producerBinding : createAgentResourceRef(scope, 'producer');
      if (index > 0) await fixture.adapter.producers.bind({ binding: producerBinding, chatId });
      const handle = await fixture.adapter.execution.start({ ...fixture.request, chatId, runId: `run-${index}`, producerBinding });
      await expect(fixture.adapter.execution.abort(handle)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    }
    expect(await fixture.adapter.execution.runningSessions()).toEqual([]);
    expect(fixture.events).toHaveLength(4097 * 2);
    publishLateRows();
    expect(fixture.events.at(-1)).toMatchObject({
      type: 'rows', rows: [{ message: { content: 'late first-chat output' } }],
    });
    expect(fixture.warnings).toEqual([]);
  });

  it('releases execution slots when native dispatch fails', async () => {
    const fixture = await createFixture(undefined, new Error('synthetic launch failure'));
    for (let index = 0; index < 4097; index++) {
      const chatId = `chat-${index + 1}`;
      const producerBinding = index === 0 ? fixture.request.producerBinding : createAgentResourceRef(scope, 'producer');
      if (index > 0) await fixture.adapter.producers.bind({ binding: producerBinding, chatId });
      await expect(fixture.adapter.execution.start({ ...fixture.request, chatId, runId: `run-${index}`, producerBinding }))
        .rejects.toThrow('synthetic launch failure');
    }
    expect(fixture.events).toEqual([]);
    expect(fixture.warnings).toEqual([]);
  });

  it('preserves a late permission fact without restoring its response authority', async () => {
    const fixture = await createFixture(({ publish, runId }) => {
      publish({ type: 'run-ended', runId, outcome: 'finished' });
      publish({
        type: 'permission', runId,
        lifecycle: permissionRequest('late', new BashToolUseMessage(TS, 'late-tool', 'pwd')),
        decision: { permissionOccurrenceId: 'late', async respond() { throw new Error('Stale response executed'); } },
      });
    });
    await fixture.adapter.execution.start(fixture.request);
    const event = fixture.events.at(-1);
    expect(event).toMatchObject({ type: 'permission', lifecycle: { kind: 'requested', permissionOccurrenceId: 'late' } });
    if (event?.type !== 'permission' || !event.decision) throw new Error('Expected requested permission');
    await expect(fixture.adapter.permissions.respond({ response: event.decision.response, decision: { allow: true } }))
      .rejects.toThrow('retired');
    expect(fixture.warnings).toEqual([]);
  });

  it('returns a resume handle before a blocking provider turn settles', async () => {
    const fixture = await createFixture();
    let resolveResume!: () => void;
    const resumed = new Promise<void>((resolve) => { resolveResume = resolve; });
    fixture.runtime.resume = () => resumed;

    const handle = await fixture.adapter.execution.resume({
      ...fixture.request,
      agentSessionId: 'session-1',
      nativeSession: null,
    });

    await expect(fixture.adapter.execution.abort(handle)).resolves.toBe(true);
    resolveResume();
    await resumed;
  });

  it('publishes an asynchronous resume launch failure', async () => {
    const fixture = await createFixture();
    fixture.runtime.resume = async () => {
      throw new Error('resume failed');
    };

    await fixture.adapter.execution.resume({
      ...fixture.request,
      agentSessionId: 'session-1',
      nativeSession: null,
    });
    await Promise.resolve();

    expect(fixture.events).toEqual([{
      type: 'run-ended',
      runId: 'run-1',
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: 'resume failed' },
    }]);
  });
});

// Compaction reaches the transcript through runExisting, which must hand the
// operation the same capability start and resume get rather than a path of its own.
it('publishes a runExisting operation through the same capability as a run', async () => {
  const fixture = await createFixture();
  let published = false;

  const outcome = await fixture.adapter.runExisting(
    { ...fixture.request, agentSessionId: 'session-1', nativeSession: null },
    async (request, publish) => {
      expect(request).not.toHaveProperty('sink');
      publish({
        type: 'rows',
        rows: runtimeRows([new AssistantMessage(TS, 'compacted')]),
      });
      published = true;
      return 'done';
    },
  );

  expect(published).toBeTrue();
  expect(outcome.value).toBe('done');
  expect(fixture.events.map((event) => event.type)).toContain('rows');
});

// The reported failure: a provider callback that outlived the transcript it was started
// against. Sink A is closed and replaced by sink B, then A's delayed callback fires. The event
// must reach A's closed sink and be dropped, never B's open one.
it('keeps a delayed callback on its own sink after a replacement takes over the chat', async () => {
  const delivered: Array<{ sink: 'a' | 'b'; event: AgentProducerEvent }> = [];
  let closedA = false;
  const sinkA: AgentProducerSink = {
    publish: (event) => {
      if (closedA) throw new Error('Transcript producer sink is closed');
      delivered.push({ sink: 'a', event });
    },
  };
  const sinkB: AgentProducerSink = {
    publish: (event) => { delivered.push({ sink: 'b', event }); },
  };
  const warnings: string[] = [];
  let delayed: (() => void) | null = null;
  const runtime: AgentRuntimeExecution = {
    async start(request, publish) {
      if (request.runId === 'run-a') {
        delayed = () => publish({
          type: 'rows',
          rows: runtimeRows([new AssistantMessage(TS, 'from the replaced generation')]),
        });
      }
      return { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null };
    },
    async resume() {},
    async abort() { return true; },
    runningSessions() { return []; },
  };
  const adapter = createAgentProducerAdapter(runtime, { scope, logger: {
    debug() {}, info() {}, error() {},
    warn: (message: string) => { warnings.push(message); },
  } satisfies AgentLogger });
  const bindingA = createAgentResourceRef(scope, 'producer');
  const bindingB = createAgentResourceRef(scope, 'producer');
  adapter.producers.subscribe(({ binding, event }) => {
    if (event.type === 'started') return;
    (binding.id === bindingA.id ? sinkA : sinkB).publish(event);
  });
  await adapter.producers.bind({ binding: bindingA, chatId: 'chat-1' });
  await adapter.producers.bind({ binding: bindingB, chatId: 'chat-1' });
  const baseRequest = {
    chatId: 'chat-1',
    projectPath: '/tmp/project',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'medium',
    settings: { ownerId: 'test', schemaVersion: 1, values: {} },
    endpoint: null,
    admission: { signal: new AbortController().signal, async markStarted() {} },
    prompt: 'hello',
    attachments: [],
    carriedContext: null,
  };

  await adapter.execution.start({ ...baseRequest, runId: 'run-a', producerBinding: bindingA } satisfies AgentStartRequestV5);
  closedA = true;
  await adapter.producers.close(bindingA);
  await adapter.execution.start({ ...baseRequest, runId: 'run-b', producerBinding: bindingB } satisfies AgentStartRequestV5);
  delivered.length = 0;

  delayed?.();

  expect(delivered).toEqual([]);
  expect(warnings.some((warning) => warning.includes('unavailable transcript sink'))).toBeTrue();
});

async function createFixture(
  afterSession?: (input: {
    readonly publish: AgentRuntimePublisher;
    readonly runId: string;
  }) => void,
  startError?: Error,
) {
  const events: AgentProducerEvent[] = [];
  const runtime: AgentRuntimeExecution = {
    async start(request, publish) {
      if (startError) throw startError;
      const session = {
        agentSessionId: 'session-1',
        nativeSession: null,
        nativeSeedReceipt: null,
      };
      publish({
        type: 'session',
        session,
      });
      if (afterSession) afterSession({ publish, runId: request.runId });
      else {
        publish({
          type: 'rows',
          rows: runtimeRows([new AssistantMessage(TS, 'answer')]),
        });
        publish({
          type: 'run-ended',
          runId: request.runId,
          outcome: 'finished',
        });
      }
      return session;
    },
    async resume() {},
    async abort() { return true; },
    runningSessions() { return []; },
  };
  let sinkClosed = false;
  const sink: AgentProducerSink = {
    publish: (event) => {
      if (sinkClosed) throw new Error('Transcript producer sink is closed');
      events.push(event);
    },
  };
  const warnings: Array<{ message: string; fields: unknown }> = [];
  const logger = {
    debug() {},
    info() {},
    warn: (message: string, fields?: unknown) => { warnings.push({ message, fields }); },
    error() {},
  } satisfies AgentLogger;
  const adapter = createAgentProducerAdapter(runtime, { logger, scope });
  const producerBinding = createAgentResourceRef(scope, 'producer');
  adapter.producers.subscribe(({ event }) => { if (event.type !== 'started') sink.publish(event); });
  await adapter.producers.bind({ binding: producerBinding, chatId: 'chat-1' });
  const request = {
    chatId: 'chat-1',
    projectPath: '/tmp/project',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'medium',
    settings: { ownerId: 'test', schemaVersion: 1, values: {} },
    endpoint: null,
    runId: 'run-1',
    producerBinding,
    prompt: 'hello',
    attachments: [],
    carriedContext: null,
  } satisfies AgentStartRequestV5;
  return {
    adapter,
    events,
    request,
    runtime,
    warnings,
    closeSink: () => { sinkClosed = true; },
  };
}

function permissionRequest(
  permissionOccurrenceId: string,
  requestedTool: BashToolUseMessage,
) {
  return {
    kind: 'requested' as const,
    permissionOccurrenceId,
    requestedTool,
    options: [],
  };
}

function permissionCancellation(permissionOccurrenceId: string) {
  return {
    kind: 'cancelled' as const,
    permissionOccurrenceId,
    reason: 'aborted',
  };
}

function permissionDecision(permissionOccurrenceId: string) {
  return {
    permissionOccurrenceId,
    respond: async () => undefined,
  };
}
