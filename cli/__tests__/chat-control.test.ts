import { describe, expect, test } from 'bun:test';
import type {
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  AgentTurnCommandResponse,
  SteerCommandRequest,
  SteerCommandResponse,
} from '@garcon/common/chat-command-contracts';
import { resumeChatAsync, stopChat, type ChatControlClient, type ChatControlDependencies } from '../chat-control.js';
import { CliError } from '../errors.js';
import { GarconHttpError, GarconTransportError } from '../garcon-client.js';

const CHAT_ID = '1785337200123456';

function acceptedTurn(overrides: Partial<AgentTurnCommandResponse> = {}): AgentTurnCommandResponse {
  return {
    success: true,
    commandType: 'agent-run',
    clientRequestId: 'request',
    chatId: CHAT_ID,
    turnId: 'turn-1',
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
    ...overrides,
  };
}

function busyError(): GarconHttpError {
  return new GarconHttpError('submission', 'chat is busy', 409, 'SESSION_BUSY', true);
}

function steerError(code: string): GarconHttpError {
  return new GarconHttpError('submission', `steer rejected: ${code}`, 409, code, false);
}

// Deterministic policy tests never wait on the real 50 ms transition delay.
function noDelayDependencies(createId: () => string = () => 'id'): ChatControlDependencies {
  return { createId, delay: async () => undefined };
}

function client(overrides: Partial<ChatControlClient> = {}): ChatControlClient & {
  runs: AgentRunCommandRequest[];
  steers: SteerCommandRequest[];
  stops: AgentStopCommandRequest[];
} {
  const runs: AgentRunCommandRequest[] = [];
  const steers: SteerCommandRequest[] = [];
  const stops: AgentStopCommandRequest[] = [];
  const base: ChatControlClient = {
    async getChatSnapshot() {
      return {
        observedAt: new Date().toISOString(),
        messageLimit: 1,
        chat: {
          id: CHAT_ID,
          title: 'Chat',
          agentId: 'claude',
          agentOwnershipEpoch: 'epoch-1',
          carryOverRevision: 'carry-v1:0',
          model: 'model',
          apiProviderId: null,
          modelEndpointId: null,
          modelProtocol: null,
          permissionMode: 'default',
          thinkingMode: 'default',
          projectPath: '/tmp',
          tags: [],
          activity: { createdAt: null, lastActivityAt: null },
        },
        processingPhase: null,
        control: {
          serverInstanceId: 'id',
          queue: {
            entries: [],
            steeringEntryId: null,
            recentlyDispatched: [],
            pause: null,
            reorderRevision: 0,
          },
          version: 0,
          updatedAt: null,
        },
        transientFeed: {
          serverInstanceId: 'id',
          chatId: CHAT_ID,
          transcriptViewId: 'view-1',
          transientRevision: 0,
          rows: [],
        },
        transcript: { availability: 'available', transcriptViewId: 'view-1', messages: [], lastOrdinal: 0, pageOldestOrdinal: 0, pageNewestOrdinal: 0, hasMore: false },
      };
    },
    async runChat() { return acceptedTurn(); },
    async steerChat() {
      return { ...acceptedTurn(), commandType: 'steer', turnId: 'turn-active' };
    },
    async stopChat() {
      return {
        ...acceptedTurn(), commandType: 'agent-stop', outcome: 'interrupt-requested',
      };
    },
  };
  return {
    runs, steers, stops,
    async getChatSnapshot(chatId, messageLimit, signal) {
      return overrides.getChatSnapshot
        ? overrides.getChatSnapshot.call(this, chatId, messageLimit, signal)
        : base.getChatSnapshot(chatId, messageLimit, signal);
    },
    async runChat(request, signal) {
      runs.push(request);
      return overrides.runChat ? overrides.runChat.call(this, request, signal) : base.runChat(request, signal);
    },
    async steerChat(request, signal) {
      steers.push(request);
      return overrides.steerChat ? overrides.steerChat.call(this, request, signal) : base.steerChat(request, signal);
    },
    async stopChat(request, signal) {
      stops.push(request);
      return overrides.stopChat ? overrides.stopChat.call(this, request, signal) : base.stopChat(request, signal);
    },
  };
}

describe('resumeChatAsync', () => {
  test('accepts a run on the first attempt and never calls steer', async () => {
    const testClient = client();
    const result = await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Implement it', allowSteer: false },
      testClient,
      undefined,
      noDelayDependencies(),
    );
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(0);
    expect(result).toMatchObject({
      delivery: 'new-turn',
      response: { chatId: CHAT_ID, turnId: 'turn-1' },
    });
  });

  test('uses a new turn for an idle chat even when steering is allowed', async () => {
    const testClient = client();
    const result = await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Implement it', allowSteer: true },
      testClient,
      undefined,
      noDelayDependencies(),
    );
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(0);
    expect(result.delivery).toBe('new-turn');
  });

  test('fails without steering when the chat is busy and --allow-steer is absent', async () => {
    const testClient = client({ async runChat() { throw busyError(); } });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: false },
      testClient, undefined, noDelayDependencies(),
    )).rejects.toMatchObject({
      phase: 'submission',
      message: expect.stringMatching(/chat is busy.*paused or queued work in Garcon/),
      exitCode: 3,
    });
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(0);
  });

  test('steers after a definitive busy rejection and prints delivery: steer', async () => {
    const testClient = client({
      async runChat() { throw busyError(); },
    });
    const result = await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient,
      undefined,
      noDelayDependencies(),
    );
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(1);
    expect(testClient.steers[0]).toMatchObject({ chatId: CHAT_ID, content: 'Message' });
    expect(result).toMatchObject({
      delivery: 'steer',
      response: { chatId: CHAT_ID, turnId: 'turn-active' },
    });
  });

  test('alternates run-steer-run when the steer target is unavailable', async () => {
    let runCalls = 0;
    const testClient = client({
      async runChat() {
        runCalls += 1;
        if (runCalls === 1) throw busyError();
        return acceptedTurn();
      },
      async steerChat() { throw steerError('STEER_TURN_UNAVAILABLE'); },
    });
    const result = await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient,
      undefined,
      noDelayDependencies(),
    );
    expect(testClient.runs).toHaveLength(2);
    expect(testClient.steers).toHaveLength(1);
    expect(result.delivery).toBe('new-turn');
  });

  test('preserves presentation across run and steer route switches', async () => {
    let runCalls = 0;
    const testClient = client({
      async runChat() {
        runCalls += 1;
        if (runCalls === 1) throw busyError();
        return acceptedTurn();
      },
      async steerChat() { throw steerError('STEER_TURN_UNAVAILABLE'); },
    });
    const presentation = { origin: 'cli', style: 'info', title: 'Context' } as const;
    await resumeChatAsync({
      chatId: CHAT_ID,
      content: 'Message',
      allowSteer: true,
      userMessagePresentation: presentation,
    }, testClient, undefined, noDelayDependencies());

    expect(testClient.runs).toHaveLength(2);
    expect(testClient.runs[0]).toEqual(testClient.runs[1]);
    expect(testClient.runs[0]?.userMessagePresentation).toEqual(presentation);
    expect(testClient.steers[0]?.userMessagePresentation).toEqual(presentation);
  });

  test('reports bounded exhaustion after run-steer-run with a second busy rejection', async () => {
    const testClient = client({
      async runChat() { throw busyError(); },
      async steerChat() { throw steerError('STEER_TURN_CHANGED'); },
    });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient, undefined, noDelayDependencies(),
    )).rejects.toMatchObject({
      message: expect.stringMatching(/not sent after 3 attempts.*last result: chat is busy/),
      exitCode: 3,
    });
    expect(testClient.runs).toHaveLength(2);
    expect(testClient.steers).toHaveLength(1);
  });

  test('reuses the exact run request identity when returning to /run', async () => {
    let runCalls = 0;
    const testClient = client({
      async runChat(request) {
        runCalls += 1;
        if (runCalls === 1) throw busyError();
        return acceptedTurn();
      },
      async steerChat() { throw steerError('STEER_TURN_UNAVAILABLE'); },
    });
    await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient,
      undefined,
      noDelayDependencies(() => 'fixed-id'),
    );
    expect(testClient.runs).toHaveLength(2);
    expect(testClient.runs[0]).toEqual(testClient.runs[1]);
    expect(testClient.runs[0]).toEqual({
      clientRequestId: 'fixed-id',
      clientMessageId: 'fixed-id',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      command: 'Message',
    });
  });

  test('gives the steer attempt an identity distinct from the run request', async () => {
    const ids = ['run-request', 'run-message', 'steer-request', 'steer-message'];
    const testClient = client({ async runChat() { throw busyError(); } });
    await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient,
      undefined,
      noDelayDependencies(() => ids.shift()!),
    );
    expect(testClient.steers[0]).toMatchObject({
      clientRequestId: 'steer-request',
      clientMessageId: 'steer-message',
    });
  });

  test.each([
    ['transport failure', new GarconTransportError('submission', 'request could not reach the server')],
    ['unknown delivery', steerError('STEER_OUTCOME_UNKNOWN')],
    ['not delivered', steerError('STEER_NOT_DELIVERED')],
    ['not steerable', steerError('STEER_TURN_NOT_STEERABLE')],
    ['provider rejected', steerError('STEER_PROVIDER_REJECTED')],
    ['shutdown', steerError('SERVER_SHUTTING_DOWN')],
    ['capacity exhausted', steerError('STEER_CAPACITY_EXHAUSTED')],
    ['validation', steerError('VALIDATION_FAILED')],
    ['authentication', new GarconHttpError('authentication', 'unauthorized', 401, 'INVALID_AUTH', false)],
    ['not found', steerError('SESSION_NOT_FOUND')],
  ])('never switches route after %s', async (_label, steerFailure) => {
    const testClient = client({
      async runChat() { throw busyError(); },
      async steerChat() { throw steerFailure; },
    });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient, undefined, noDelayDependencies(),
    )).rejects.toBeInstanceOf(CliError);
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(1);
  });

  test('does not steer when a busy code arrives on a non-409 status', async () => {
    const nonConflict = new GarconHttpError('submission', 'busy', 500, 'SESSION_BUSY', true);
    const testClient = client({ async runChat() { throw nonConflict; } });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient, undefined, noDelayDependencies(),
    )).rejects.toBe(nonConflict);
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(0);
  });

  test('does not steer after an unrelated 409 run rejection', async () => {
    const rejection = new GarconHttpError(
      'submission',
      'agent mismatch',
      409,
      'EXPECTED_AGENT_MISMATCH',
      false,
    );
    const testClient = client({ async runChat() { throw rejection; } });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient, undefined, noDelayDependencies(),
    )).rejects.toBe(rejection);
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(0);
  });

  test('does not switch route when a safe-steer code arrives on a non-409 status', async () => {
    const nonConflict = new GarconHttpError(
      'submission',
      'steer rejected',
      500,
      'STEER_TURN_UNAVAILABLE',
      false,
    );
    const testClient = client({
      async runChat() { throw busyError(); },
      async steerChat() { throw nonConflict; },
    });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient, undefined, noDelayDependencies(),
    )).rejects.toBe(nonConflict);
    expect(testClient.runs).toHaveLength(1);
    expect(testClient.steers).toHaveLength(1);
  });

  test('delays 50 ms only between safe transitions and passes the abort signal', async () => {
    const delays: Array<[number, AbortSignal | undefined]> = [];
    const controller = new AbortController();
    const testClient = client({
      async runChat() { throw busyError(); },
      async steerChat() { throw steerError('STEER_TURN_CHANGED'); },
    });
    await expect(resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: true },
      testClient, controller.signal, {
        createId: () => 'id',
        delay: async (milliseconds, signal) => { delays.push([milliseconds, signal]); },
      },
    )).rejects.toThrow('not sent after 3 attempts');
    expect(delays).toEqual([[50, controller.signal], [50, controller.signal]]);
  });

  test('omits tags, overrides, and permission fallback from the run payload', async () => {
    const testClient = client();
    await resumeChatAsync(
      { chatId: CHAT_ID, content: 'Message', allowSteer: false },
      testClient,
      undefined,
      noDelayDependencies(),
    );
    expect(testClient.runs[0]).toEqual({
      clientRequestId: 'id',
      clientMessageId: 'id',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      command: 'Message',
    });
  });
});

describe('stopChat', () => {
  test('accepts interrupt-requested and already-idle outcomes', async () => {
    for (const outcome of ['interrupt-requested', 'already-idle']) {
      let captured: AgentStopCommandRequest | undefined;
      const stopClient: ChatControlClient = {
        async runChat() { throw new Error('unused'); },
        async steerChat() { throw new Error('unused'); },
        async stopChat(request) {
          captured = request;
          return {
            ...acceptedTurn(), commandType: 'agent-stop', outcome: outcome as 'interrupt-requested' | 'already-idle',
          };
        },
      };
      const result = await stopChat(CHAT_ID, stopClient, undefined, {
        createId: () => 'stop-id',
      });
      expect(captured).toEqual({ clientRequestId: 'stop-id', chatId: CHAT_ID });
      expect(result.response.outcome).toBe(outcome);
    }
  });

  test('rejects a failed stop without printing success', async () => {
    const stopClient: ChatControlClient = {
      async runChat() { throw new Error('unused'); },
      async steerChat() { throw new Error('unused'); },
      async stopChat() {
        return {
          ...acceptedTurn(), commandType: 'agent-stop', outcome: 'failed',
        };
      },
    };
    await expect(stopChat(CHAT_ID, stopClient, undefined, { createId: () => 'id' }))
      .rejects.toMatchObject({ exitCode: 3 });
  });
});
