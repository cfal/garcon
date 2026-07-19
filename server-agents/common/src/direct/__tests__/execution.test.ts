import { describe, expect, mock, test } from 'bun:test';
import type { AgentEndpointSelection } from '@garcon/common/agent-execution';
import type {
  AgentHost,
  AgentResumeRequest,
} from '@garcon/server-agent-interface';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
import { DirectExecution } from '../execution.js';
import {
  DirectEndpointRouterRuntime,
  type DirectCompatibleRuntime,
} from '../router.js';
import type { DirectResumeRequest } from '../runtime-types.js';

const endpoint = {
  apiProviderId: 'provider-1',
  endpointId: 'endpoint-1',
  providerLabel: 'Provider One',
  protocol: 'openai-compatible',
  baseUrl: 'https://example.test/v1',
  model: 'model-1',
  isLocal: false,
  capabilities: { chatCompletions: true, responses: false },
  headers: {},
  credential: null,
} satisfies AgentEndpointSelection;

function createHost(): AgentHost {
  return {
    agentId: 'direct-test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: '/tmp',
      directory: async () => '/tmp',
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
    carryOver: {
      load: async () => ({ revision: 'empty', messages: [] }),
    },
  };
}

function resumeRequest(): AgentResumeRequest {
  return {
    chatId: 'chat-1',
    projectPath: '/repo',
    model: endpoint.model,
    permissionMode: 'default',
    thinkingMode: 'default',
    settings: { ownerId: 'direct-test', schemaVersion: 1, values: {} },
    endpoint,
    operation: {
      commandType: 'agent-run',
      clientRequestId: 'request-1',
      clientMessageId: 'message-1',
      turnId: 'turn-1',
    },
    admission: {
      signal: new AbortController().signal,
      markStarted() {},
      markAbortable() {},
    },
    agentSessionId: 'session-1',
    nativeSession: null,
    prompt: 'continued successor',
    attachments: [],
    directHistoryRecovery: 'allow-empty',
  };
}

describe('DirectExecution', () => {
  test('preserves recovered-history admission through the runtime adapter', async () => {
    const runTurn = mock(async (_request: DirectResumeRequest) => undefined);
    const runtime = {
      startSession: mock(async () => ({ agentSessionId: 'session-1', nativePath: '/tmp/session-1' })),
      runTurn,
      abort: mock(() => false),
      isRunning: mock(() => false),
      getRunningSessions: mock(() => []),
      startPurgeTimer: mock(() => undefined),
      onMessages: mock(() => undefined),
      onProcessing: mock(() => undefined),
      onSessionCreated: mock(() => undefined),
      onFinished: mock(() => undefined),
      onFailed: mock(() => undefined),
    } satisfies DirectCompatibleRuntime;
    const router = new DirectEndpointRouterRuntime({
      label: 'Direct Test',
      protocol: 'openai-compatible',
      createRuntime: () => runtime,
      runSingleQuery: async () => '',
    });
    const execution = new DirectExecution(
      createHost(),
      router,
      createPathNativeSessionCodec('direct-test'),
    );

    await execution.resume(resumeRequest());

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0]?.[0]).toMatchObject({
      agentSessionId: 'session-1',
      command: 'continued successor',
      directHistoryRecovery: 'allow-empty',
    });
  });
});
