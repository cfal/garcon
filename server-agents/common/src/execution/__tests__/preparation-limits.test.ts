import { expect, test, spyOn } from 'bun:test';
import { AgentCallError, AgentIntegrationError, createAgentResourceRef, type AgentResumeRequestV5, type AgentChatReference } from '@garcon/server-agent-interface';
import { createAgentProducerAdapter } from '../producer-adapter.js';
import { createAgentSteering } from '../control-adapters.js';
import { createAgentProjectPathUpdates } from '../project-path-adapter.js';
import type { AgentRuntimeExecution } from '../runtime-events.js';

const scope = { executorId: 'node', instanceId: 'runtime', integrationId: 'test' };
const chat = {
  chatId: 'chat', agentId: 'test', agentSessionId: 'native', projectPath: '/project',
  model: 'model', nativeSession: null, nativeSeedReceipt: null, carryOverRevision: 'revision',
  settings: { ownerId: 'test', schemaVersion: 1, values: {} },
} satisfies AgentChatReference;

test('a full steering table rejects without arming an orphaned timer', async () => {
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const clock = spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
    const timer = set(() => {}, 60_000);
    timer.unref();
    timers.set(timer, () => callback());
    return timer;
  });
  try {
    const runtime = {
      async start() { return { agentSessionId: 'native', nativeSession: null, nativeSeedReceipt: null }; },
      async resume() {}, async abort() { return true; }, runningSessions() { return []; },
    } satisfies AgentRuntimeExecution;
    const producer = createAgentProducerAdapter(runtime, { scope, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const producerBinding = createAgentResourceRef(scope, 'producer');
    await producer.producers.bind({ binding: producerBinding, chatId: 'chat' });
    const request = {
      chatId: 'chat', runId: 'run', agentSessionId: 'native', nativeSession: null,
      producerBinding, projectPath: '/project', model: 'model', permissionMode: 'default',
      thinkingMode: 'none', settings: { ownerId: 'test', schemaVersion: 1, values: {} },
      endpoint: null, prompt: 'input', attachments: [],
    } satisfies AgentResumeRequestV5;
    await producer.execution.resume(request);
    const steering = createAgentSteering(producer, { captureTarget: () => ({}), async steer() { return { kind: 'accepted' }; } });
    const capture = { ...request, expectedRunId: 'run' };
    for (let index = 0; index < 256; index++) await steering.captureTarget(capture);
    await expect(steering.captureTarget(capture)).rejects.toThrow('budget exhausted');
    expect(timers.size).toBe(256);
    for (const expire of timers.values()) expect(expire).not.toThrow();
    expect(await steering.captureTarget(capture)).not.toBeNull();
  } finally {
    clock.mockRestore();
    for (const timer of timers.keys()) clear(timer);
  }
});

test.each([
  'SESSION_BUSY', 'SESSION_NOT_FOUND', 'OPERATION_UNSUPPORTED',
  'TRANSCRIPT_UNAVAILABLE', 'PROJECT_PATH_DESTINATION_REJECTED',
] as const)('a %s path refusal permits a corrected destination', async (code) => {
  let attempts = 0;
  const paths = createAgentProjectPathUpdates(scope, async () => {
    if (attempts++ === 0) throw new AgentIntegrationError(code, 'Path update refused', false);
  });
  await expect(paths.prepare({ chat, nextProjectPath: '/wrong' })).rejects.toMatchObject({ code });
  expect(await paths.prepare({ chat, nextProjectPath: '/correct' })).toBeNull();
  expect(attempts).toBe(2);
});

test.each([
  new AgentIntegrationError('TIMEOUT', 'Timed out', true),
  new AgentIntegrationError('UNAVAILABLE', 'Unavailable', true),
  new AgentIntegrationError('PROVIDER_FAILURE', 'Native failure', false),
  new AgentCallError('unknown', 'Lost result', 'SESSION_BUSY'),
  new AgentCallError('unknown', 'Lost refusal', 'PROJECT_PATH_DESTINATION_REJECTED'),
])('keeps an uncertain path preparation blocked: %s', async (error) => {
  let attempts = 0;
  const paths = createAgentProjectPathUpdates(scope, async () => {
    attempts++;
    throw error;
  });
  await expect(paths.prepare({ chat, nextProjectPath: '/next' })).rejects.toBe(error);
  await expect(paths.prepare({ chat, nextProjectPath: '/retry' })).rejects.toThrow('reconciliation');
  expect(attempts).toBe(1);
});

test.each(['rejected', 'not-dispatched'] as const)('permits retry after a %s path preparation', async (outcome) => {
  let attempts = 0;
  const paths = createAgentProjectPathUpdates(scope, async () => {
    if (attempts++ === 0) throw new AgentCallError(outcome, 'No change', 'UNAVAILABLE');
  });
  await expect(paths.prepare({ chat, nextProjectPath: '/next' })).rejects.toMatchObject({ outcome });
  expect(await paths.prepare({ chat, nextProjectPath: '/retry' })).toBeNull();
  expect(attempts).toBe(2);
});

test('path capacity is reserved before native mutation and ambiguity stays quarantined', async () => {
  let mutations = 0;
  const paths = createAgentProjectPathUpdates(scope, async () => {
    mutations++;
    throw new Error('Native result lost');
  });
  for (let index = 0; index < 64; index++) {
    await expect(paths.prepare({ chat: { ...chat, chatId: `chat-${index}` }, nextProjectPath: '/next' }))
      .rejects.toThrow('Native result lost');
  }
  await expect(paths.prepare({ chat: { ...chat, chatId: 'overflow' }, nextProjectPath: '/next' }))
    .rejects.toThrow('budget exhausted');
  await expect(paths.prepare({ chat: { ...chat, chatId: 'chat-0' }, nextProjectPath: '/retry' }))
    .rejects.toThrow('reconciliation');
  expect(mutations).toBe(64);
});
