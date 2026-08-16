import { describe, expect, mock, test } from 'bun:test';
import {
  type AgentHost,
} from '@garcon/server-agent-interface';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { AgentEventEmitterRuntime } from '../../shared/event-emitter-runtime.js';
import type {
  AgentRuntimeEvent,
  AgentRuntimeOperation,
  AgentRuntimeResumeRequest,
  AgentRuntimeStartRequest,
} from '../../execution/runtime-events.js';
import { DirectExecution } from '../execution.js';

function endpoint(endpointId: string) {
  return {
    apiProviderId: 'provider',
    endpointId,
    providerLabel: 'Provider',
    protocol: 'openai-compatible' as const,
    baseUrl: `https://${endpointId}.example.test`,
    model: 'model',
    isLocal: false,
    capabilities: null,
    headers: {},
    credential: null,
  };
}

function host(): AgentHost {
  return {
    agentId: 'direct-test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: '/tmp',
      directory: async () => '/tmp',
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
  };
}

function request(modelEndpointId: string): AgentRuntimeResumeRequest {
  return {
    chatId: 'chat-1',
    projectPath: '/tmp',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings: { ownerId: 'direct-test', schemaVersion: 1, values: {} },
    endpoint: endpoint(modelEndpointId),
    runId: 'run-1',
    priorContext: [new UserMessage('2026-01-01T00:00:00.000Z', 'earlier')],
    agentSessionId: 'session-1',
    nativeSession: null,
    prompt: 'continue',
    attachments: [],
    admission: {
      signal: new AbortController().signal,
      async markStarted() {},
    },
  };
}

describe('DirectExecution', () => {
  test('sends frozen history as context and keeps the new prompt separate', async () => {
    const startSession = mock(async () => ({
      agentSessionId: 'session-1',
      nativePath: '/tmp/session-1.json',
    }));
    const subscribe = () => {};
    const runtime = {
      startSession,
      onMessages: subscribe,
      onProcessing: subscribe,
      onFinished: subscribe,
      onFailed: subscribe,
    };
    const execution = new DirectExecution(host(), runtime as never);
    const { agentSessionId: _agentSessionId, nativeSession: _nativeSession, ...base } = request('endpoint-a');
    const start: AgentRuntimeStartRequest = {
      ...base,
      carriedContext: { prefix: '<carried>history</carried>\n\n' },
    };

    await execution.start(start, () => {});

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      priorContext: start.priorContext,
      command: 'continue',
    }));
  });

  test('forwards core-owned context when rebuilding a stateless request', async () => {
    const runTurn = mock(async () => {});
    const subscribe = () => {};
    const runtime = {
      runTurn,
      onMessages: subscribe,
      onProcessing: subscribe,
      onFinished: subscribe,
      onFailed: subscribe,
    };
    const execution = new DirectExecution(host(), runtime as never);
    const resume = request('endpoint-b');

    await expect(execution.resume(resume, () => {})).resolves.toBeUndefined();
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      priorContext: resume.priorContext,
      command: 'continue',
    }));
  });

	test('[TLV5-L07.03-DIRECT-UNIT-01] keeps each concrete request bound to the publisher that created it', async () => {
    const operations: AgentRuntimeOperation[] = [];
    const runtime = {
      startSession: mock(async (input: { operation: AgentRuntimeOperation }) => {
        operations.push(input.operation);
        if (operations.length === 2) throw new Error('replacement failed');
        return { agentSessionId: 'session-1', nativePath: '/tmp/session-1.json' };
      }),
    };
    const execution = new DirectExecution(host(), runtime as never);
    const { agentSessionId: _agentSessionId, nativeSession: _nativeSession, ...start } = request('endpoint-a');
    const firstEvents: AgentRuntimeEvent[] = [];
    const replacementEvents: AgentRuntimeEvent[] = [];

    await execution.start({ ...start, carriedContext: null }, (event) => firstEvents.push(event));
    await expect(execution.start(
      { ...start, runId: 'run-2', carriedContext: null },
      (event) => replacementEvents.push(event),
    )).rejects.toThrow('replacement failed');

    operations[0].publish({
      type: 'messages',
      runId: operations[0].runId,
      rows: [],
    });

    expect(firstEvents).toHaveLength(1);
    expect(replacementEvents).toEqual([]);
  });

	test('[TLV5-L07.05-DIRECT-UNIT-01] does not route an unnamed runtime emission through a current request', async () => {
    const emitted: AgentRuntimeEvent[] = [];
    const runtime = new AgentEventEmitterRuntime() as AgentEventEmitterRuntime & {
      startSession: () => Promise<{ agentSessionId: string; nativePath: string }>;
    };
    runtime.startSession = mock(async () => ({
      agentSessionId: 'session-1',
      nativePath: '/tmp/session-1.json',
    }));
    const execution = new DirectExecution(host(), runtime as never);
    const { agentSessionId: _agentSessionId, nativeSession: _nativeSession, ...start } = request('endpoint-a');

    await execution.start({ ...start, carriedContext: null }, (event) => emitted.push(event));
    runtime.emitMessages('chat-1', [
      new AssistantMessage('2026-01-01T00:00:00.000Z', 'unnamed'),
    ]);

    expect(emitted).toEqual([]);
  });
});
