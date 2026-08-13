import { describe, expect, it } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
} from '@garcon/common/chat-types';
import type {
  AgentProducerEvent,
  AgentProducerSink,
  AgentStartRequestV5,
} from '@garcon/server-agent-interface';
import {
  AgentRuntimeEventChannel,
  runtimeRows,
  type AgentRuntimeExecution,
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
    const fixture = createFixture(({ channel, runId }) => {
      const tool = new BashToolUseMessage(TS, 'tool-1', 'pwd');
      channel.emit({
        type: 'messages',
        chatId: 'chat-1',
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

function createFixture(
  afterSession?: (input: {
    readonly channel: AgentRuntimeEventChannel;
    readonly runId: string;
  }) => void,
  startError?: Error,
) {
  const events: AgentProducerEvent[] = [];
  const channel = new AgentRuntimeEventChannel();
  const runtime: AgentRuntimeExecution = {
    async start(request) {
      if (startError) throw startError;
      const session = {
        agentSessionId: 'session-1',
        nativeSession: null,
        nativeSeedReceipt: null,
      };
      channel.emit({
        type: 'session',
        chatId: request.chatId,
        session,
      });
      if (afterSession) afterSession({ channel, runId: request.runId });
      else {
        channel.emit({
          type: 'messages',
          chatId: request.chatId,
          runId: request.runId,
          rows: runtimeRows([new AssistantMessage(TS, 'answer')]),
        });
        channel.emit({
          type: 'run-ended',
          chatId: request.chatId,
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
    subscribeRuntimeEvents: listener => channel.subscribe(listener),
  };
  const sink: AgentProducerSink = { publish: event => events.push(event) };
  const adapter = createAgentProducerAdapter(runtime);
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
  return { adapter, events, request, runtime };
}
