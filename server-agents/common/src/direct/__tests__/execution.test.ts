import { describe, expect, mock, test } from 'bun:test';
import type { AgentExecutionContext, AgentHost } from '@garcon/server-agent-interface';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
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

function request(modelEndpointId: string): AgentExecutionContext {
  return {
    chatId: 'chat-1',
    projectPath: '/tmp',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings: { ownerId: 'direct-test', schemaVersion: 1, values: {} },
    endpoint: endpoint(modelEndpointId),
    operation: {
      commandType: 'agent-run',
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    },
    prompt: 'continue',
    attachments: [],
    admission: {
      signal: new AbortController().signal,
      markStarted() {},
      markAbortable() {},
    },
  };
}

describe('DirectExecution', () => {
  test('fails closed when a materialized session requests another endpoint', async () => {
    const runTurn = mock(async () => {});
    const subscribe = () => {};
    const runtime = {
      runTurn,
      onMessages: subscribe,
      onProcessing: subscribe,
      onFinished: subscribe,
      onFailed: subscribe,
    };
    const nativeSessions = createPathNativeSessionCodec('direct-test');
    const execution = new DirectExecution(host(), runtime as never, nativeSessions);
    const resume = request('endpoint-b');
    resume.nativeSession = nativeSessions.encode({
      path: '/tmp/endpoint-a/session.jsonl',
      agentSessionId: 'session-1',
      modelEndpointId: 'endpoint-a',
    });
    resume.agentSessionId = 'session-1';

    await expect(execution.resume(resume)).rejects.toThrow(
      'Direct sessions cannot change API provider endpoints after they start',
    );
    expect(runTurn).not.toHaveBeenCalled();
  });
});
