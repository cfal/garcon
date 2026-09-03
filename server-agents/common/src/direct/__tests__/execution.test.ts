import { describe, expect, mock, test } from 'bun:test';
import {
  type AgentHost,
} from '@garcon/server-agent-interface';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import type {
  AgentRuntimeEvent,
  AgentRuntimeOperation,
  AgentRuntimeResumeRequest,
  AgentRuntimeStartRequest,
} from '../../execution/runtime-events.js';
import { DirectExecution } from '../execution.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const PROVIDER_PREFIX = '<garcon-preambles>private instructions</garcon-preambles>\n\n';
const NATIVE_SESSION = {
  ownerId: 'direct-test',
  schemaVersion: 1,
  value: { sessionId: SESSION_ID },
} as const;

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
    agentSessionId: SESSION_ID,
    nativeSession: NATIVE_SESSION,
    prompt: 'continue',
    providerPrefix: '',
    attachments: [],
    admission: {
      signal: new AbortController().signal,
      async markStarted() {},
    },
  };
}

describe('DirectExecution', () => {
  test('prefixes a new Direct session with carried context and publishes its receipt', async () => {
    const startSession = mock(async () => ({
      agentSessionId: SESSION_ID,
      nativeSession: NATIVE_SESSION,
    }));
    const runtime = { startSession };
    const execution = new DirectExecution(host(), runtime as never);
    const { agentSessionId: _agentSessionId, nativeSession: _nativeSession, ...base } = request('endpoint-a');
    const start: AgentRuntimeStartRequest = {
      ...base,
      carriedContext: { prefix: '<carried>history</carried>\n\n' },
      providerPrefix: PROVIDER_PREFIX,
    };
    const events: AgentRuntimeEvent[] = [];

    await execution.start(start, (event) => events.push(event));

    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      command: `<carried>history</carried>\n\n${PROVIDER_PREFIX}continue`,
    }));
    expect(startSession.mock.calls[0][0]).not.toHaveProperty('priorContext');
    expect(events).toEqual([{
      type: 'session',
      session: {
        agentSessionId: SESSION_ID,
        nativeSession: NATIVE_SESSION,
        nativeSeedReceipt: receiptForCarriedContext(
          start.carriedContext,
          SESSION_ID,
          'user-prefix',
        ),
      },
    }]);
  });

  test('resumes from the exact native session without forwarding ledger context', async () => {
    const runTurn = mock(async () => {});
    const runtime = { runTurn };
    const execution = new DirectExecution(host(), runtime as never);
    const resume = { ...request('endpoint-b'), providerPrefix: PROVIDER_PREFIX };

    await expect(execution.resume(resume, () => {})).resolves.toBeUndefined();
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      nativeSession: NATIVE_SESSION,
      command: `${PROVIDER_PREFIX}continue`,
    }));
    expect(runTurn.mock.calls[0][0]).not.toHaveProperty('priorContext');
  });

	test('[TLV5-L07.03-DIRECT-UNIT-01] keeps each concrete request bound to the publisher that created it', async () => {
    const operations: AgentRuntimeOperation[] = [];
    const runtime = {
      startSession: mock(async (input: { operation: AgentRuntimeOperation }) => {
        operations.push(input.operation);
        if (operations.length === 2) throw new Error('replacement failed');
        return { agentSessionId: SESSION_ID, nativeSession: NATIVE_SESSION };
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
      type: 'rows',
      rows: [],
    });

    expect(firstEvents.map((event) => event.type)).toEqual(['session', 'rows']);
    expect(replacementEvents).toEqual([]);
  });

	test('[TLV5-L07.05-DIRECT-UNIT-01] exposes no unnamed runtime emission surface', async () => {
    const emitted: AgentRuntimeEvent[] = [];
    const runtime = {
      startSession: mock(async () => ({
        agentSessionId: SESSION_ID,
        nativeSession: NATIVE_SESSION,
      })),
    };
    const execution = new DirectExecution(host(), runtime as never);
    const { agentSessionId: _agentSessionId, nativeSession: _nativeSession, ...start } = request('endpoint-a');

    await execution.start({ ...start, carriedContext: null }, (event) => emitted.push(event));

    expect(runtime).not.toHaveProperty('emitMessages');
    expect(emitted.map((event) => event.type)).toEqual(['session']);
  });
});
