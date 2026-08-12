import { describe, expect, mock, test } from 'bun:test';
import {
  agentOwnershipEpoch,
  type AgentExecutionContextV4,
  type AgentHost,
} from '@garcon/server-agent-interface';
import { UserMessage } from '@garcon/common/chat-types';
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

function request(modelEndpointId: string): AgentExecutionContextV4 {
  const turnOwner = {
    agentOwnershipEpoch: agentOwnershipEpoch('ownership-1'),
    commandType: 'agent-run' as const,
    clientRequestId: 'request-1',
    turnId: 'turn-1',
  };
  return {
    chatId: 'chat-1',
    projectPath: '/tmp',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings: { ownerId: 'direct-test', schemaVersion: 1, values: {} },
    endpoint: endpoint(modelEndpointId),
    operation: {
      ...turnOwner,
      clientMessageId: 'message-1',
      turnOwner,
    },
    prompt: 'continue',
    attachments: [],
    admission: {
      signal: new AbortController().signal,
      async markStarted() {},
      markAbortable() {},
    },
  };
}

describe('DirectExecution', () => {
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
    resume.nativeSession = null;
    resume.agentSessionId = 'session-1';
    resume.priorContext = [new UserMessage('2026-01-01T00:00:00.000Z', 'earlier')];

    await expect(execution.resume(resume)).resolves.toBeUndefined();
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      priorContext: resume.priorContext,
      command: 'continue',
    }));
  });
});
