import { describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
} from '@garcon/common/chat-types';
import type {
  AgentLogger,
  AgentProducerEvent,
  AgentProducerSink,
  AgentStartRequestV5,
} from '@garcon/server-agent-interface';
import {
  runtimeRows,
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

  it('turns permission messages into typed lifecycle events and drops provider resolutions', async () => {
    const fixture = createFixture(({ publish, runId }) => {
      const tool = new BashToolUseMessage(TS, 'tool-1', 'pwd');
      publish({
        type: 'messages',
        runId,
        rows: runtimeRows([
          new AssistantMessage(TS, 'before'),
          new PermissionRequestMessage(TS, 'permission-1', tool),
          new PermissionResolvedMessage(TS, 'permission-1', true),
          new PermissionCancelledMessage(TS, 'permission-1', 'aborted'),
          new AssistantMessage(TS, 'after'),
        ]),
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
      lifecycle: { kind: 'requested', requestId: 'permission-1' },
    });
    expect(cancelled).toMatchObject({
      type: 'permission',
      runId: 'run-1',
      lifecycle: { kind: 'cancelled', requestId: 'permission-1', reason: 'aborted' },
    });
  });

  it('preserves the exact permission occurrence when a request id is reused', async () => {
    const firstRequest = Object.assign(
      new PermissionRequestMessage(TS, 'shared-request', new BashToolUseMessage(TS, 'tool-1', 'first')),
      { incarnation: 'first-occurrence' },
    );
    const secondRequest = Object.assign(
      new PermissionRequestMessage(TS, 'shared-request', new BashToolUseMessage(TS, 'tool-2', 'second')),
      { incarnation: 'second-occurrence' },
    );
    const firstCancellation = Object.assign(
      new PermissionCancelledMessage(TS, 'shared-request', 'aborted'),
      { incarnation: 'first-occurrence' },
    );
    const fixture = createFixture(({ publish, runId }) => {
      publish({
        type: 'messages',
        runId,
        rows: runtimeRows([firstRequest, secondRequest, firstCancellation]),
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
  });

  it('keeps uncorrelated permission facts typed instead of leaking them into rows', async () => {
    const fixture = createFixture(({ publish }) => {
      publish({
        type: 'messages',
        runId: null,
        rows: runtimeRows([
          new PermissionRequestMessage(TS, 'permission-1', new BashToolUseMessage(TS, 'tool-1', 'pwd')),
          new PermissionCancelledMessage(TS, 'permission-1', 'aborted'),
        ]),
      });
    });

    await fixture.adapter.execution.start(fixture.request);

    const permissions = fixture.events.filter((event) => event.type === 'permission');
    expect(fixture.events.map((event) => event.type)).toEqual(['session', 'permission', 'permission']);
    expect(permissions[0]).toMatchObject({
      lifecycle: { kind: 'requested', requestId: 'permission-1' },
    });
    expect(permissions[1]).toMatchObject({
      lifecycle: { kind: 'cancelled', requestId: 'permission-1' },
    });
    const correlations = permissions.map((event) => (
      event.type === 'permission' ? event.runId : null
    ));
    expect(correlations.every((runId) => typeof runId === 'string' && runId !== 'run-1')).toBeTrue();
  });

  it('drops provider events for an unavailable sink without failing its event stream', async () => {
    const fixture = createFixture(({ publish }) => {
      fixture.closeSink();
      publish({
        type: 'messages',
        runId: 'run-1',
        rows: runtimeRows([new AssistantMessage(TS, 'after close')]),
      });
      publish({
        type: 'run-ended',
        runId: 'run-1',
        outcome: 'finished',
        exitCode: 0,
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
        type: 'messages',
        runId: 'run-1',
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
          type: 'messages',
          runId: 'run-a',
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
          type: 'messages',
          runId: request.runId,
          rows: runtimeRows([new AssistantMessage(TS, 'answer')]),
        });
        publish({
          type: 'run-ended',
          runId: request.runId,
          outcome: 'finished',
          exitCode: 0,
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
  const warnings: string[] = [];
  const logger = {
    debug() {},
    info() {},
    warn: (message: string) => { warnings.push(message); },
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
