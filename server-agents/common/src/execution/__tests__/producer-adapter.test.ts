import { describe, expect, it } from 'bun:test';
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

const TS = '2026-08-12T00:00:00.000Z';

describe('createAgentProducerAdapter', () => {
  it('publishes sessions, normalized rows, and terminal events through the supplied sink', async () => {
    const fixture = createFixture();
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
    await expect(fixture.adapter.execution.abort(handle)).resolves.toBe(true);
  });

  it('forwards typed permission lifecycle events without interpreting chat rows', async () => {
    const decision = permissionDecision('permission-1', 'incarnation-1');
    const fixture = createFixture(({ publish, runId }) => {
      const tool = new BashToolUseMessage(TS, 'tool-1', 'pwd');
      publish({
        type: 'rows',
        rows: runtimeRows([new AssistantMessage(TS, 'before')]),
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionRequest('permission-1', 'incarnation-1', tool),
        decision,
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionCancellation('permission-1', 'incarnation-1'),
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
        requestId: 'permission-1',
        incarnation: 'incarnation-1',
      },
      decision,
    });
    expect(cancelled).toMatchObject({
      type: 'permission',
      runId: 'run-1',
      lifecycle: {
        kind: 'cancelled',
        requestId: 'permission-1',
        incarnation: 'incarnation-1',
        reason: 'aborted',
      },
    });
  });

  it('[TLV5-PERM.02-ADAPTER-UNIT-01] preserves the exact permission occurrence when a request id is reused', async () => {
    const firstDecision = permissionDecision('shared-request', 'first-occurrence');
    const secondDecision = permissionDecision('shared-request', 'second-occurrence');
    const fixture = createFixture(({ publish, runId }) => {
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionRequest(
          'shared-request',
          'first-occurrence',
          new BashToolUseMessage(TS, 'tool-1', 'first'),
        ),
        decision: firstDecision,
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionRequest(
          'shared-request',
          'second-occurrence',
          new BashToolUseMessage(TS, 'tool-2', 'second'),
        ),
        decision: secondDecision,
      });
      publish({
        type: 'permission',
        runId,
        lifecycle: permissionCancellation('shared-request', 'first-occurrence'),
      });
    });

    await fixture.adapter.execution.start(fixture.request);

    expect(fixture.events.flatMap((event) => (
      event.type === 'permission' ? [event.lifecycle.incarnation] : []
    ))).toEqual([
      'first-occurrence',
      'second-occurrence',
      'first-occurrence',
    ]);
    expect(fixture.events[1]).toMatchObject({ decision: firstDecision });
    expect(fixture.events[2]).toMatchObject({ decision: secondDecision });
  });

  it('[TLV5-PERM.09-ADAPTER-UNIT-01] drops an unnamed permission event with one content-free warning', async () => {
    const decision = permissionDecision('permission-1', 'incarnation-1');
    const fixture = createFixture(({ publish }) => {
      publish({
        type: 'permission',
        runId: null,
        lifecycle: permissionRequest(
          'permission-1',
          'incarnation-1',
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
    const fixture = createFixture(({ publish }) => {
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
    const fixture = createFixture(undefined, new Error('launch failed'));

    await expect(fixture.adapter.execution.start(fixture.request)).rejects.toThrow('launch failed');
    expect(fixture.events).toEqual([]);
  });

  it('returns a resume handle before a blocking provider turn settles', async () => {
    const fixture = createFixture();
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
    const fixture = createFixture();
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

// Compaction and goal control reach the transcript through runExisting, which must hand the
// operation the same capability start and resume get rather than a path of its own.
it('publishes a runExisting operation through the same capability as a run', async () => {
  const fixture = createFixture();
  let published = false;

  const outcome = await fixture.adapter.runExisting(
    { chatId: 'chat-1', agentSessionId: 'session-1', sink: fixture.request.sink },
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
  const adapter = createAgentProducerAdapter(runtime, {
    debug() {}, info() {}, error() {},
    warn: (message: string) => { warnings.push(message); },
  } satisfies AgentLogger);
  const baseRequest = {
    chatId: 'chat-1',
    projectPath: '/tmp/project',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'medium',
    settings: { ownerId: 'test', schemaVersion: 1, values: {} },
    endpoint: null,
    priorContext: [],
    admission: { signal: new AbortController().signal, async markStarted() {} },
    prompt: 'hello',
    attachments: [],
    carriedContext: null,
  };

  await adapter.execution.start({ ...baseRequest, runId: 'run-a', sink: sinkA } satisfies AgentStartRequestV5);
  closedA = true;
  await adapter.execution.start({ ...baseRequest, runId: 'run-b', sink: sinkB } satisfies AgentStartRequestV5);
  delivered.length = 0;

  delayed?.();

  expect(delivered).toEqual([]);
  expect(warnings.some((warning) => warning.includes('unavailable transcript sink'))).toBeTrue();
});

function createFixture(
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
  const adapter = createAgentProducerAdapter(runtime, logger);
  const request = {
    chatId: 'chat-1',
    projectPath: '/tmp/project',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'medium',
    settings: { ownerId: 'test', schemaVersion: 1, values: {} },
    endpoint: null,
    runId: 'run-1',
    sink,
    priorContext: [],
    admission: {
      signal: new AbortController().signal,
      async markStarted() {},
    },
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
  requestId: string,
  incarnation: string,
  requestedTool: BashToolUseMessage,
) {
  return {
    kind: 'requested' as const,
    requestId,
    incarnation,
    requestedTool,
    options: [],
  };
}

function permissionCancellation(requestId: string, incarnation: string) {
  return {
    kind: 'cancelled' as const,
    requestId,
    incarnation,
    reason: 'aborted',
  };
}

function permissionDecision(requestId: string, incarnation: string) {
  return {
    requestId,
    incarnation,
    respond: async () => undefined,
  };
}
