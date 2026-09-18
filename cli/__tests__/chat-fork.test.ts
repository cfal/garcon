import { describe, expect, test } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  ForkChatCommandRequest,
  ForkRunCommandRequest,
  ForkRunCommandResponse,
} from '@garcon/common/chat-command-contracts';
import type { ChatListEntry } from '@garcon/common/chat-list';
import type { ForkCliCommand } from '../args.js';
import {
  createFork,
  settleForkRun,
  submitForkRun,
  type ChatForkClient,
} from '../chat-fork.js';
import { GarconClient } from '../garcon-client.js';

const SOURCE_CHAT_ID = '1785337200123456';
const TARGET_CHAT_ID = '1785337200123457';
const SECOND_TARGET_CHAT_ID = '1785337200123458';
const TIMESTAMP = '2026-09-18T12:00:00.000Z';

function chat(id = TARGET_CHAT_ID): ChatListEntry {
  return {
    id,
    parentChat: {
      chatId: SOURCE_CHAT_ID,
      relation: 'fork',
      transcriptViewId: 'view-1',
      ordinal: 4,
    },
    agentId: 'codex',
    agentOwnershipEpoch: 'epoch-1',
    model: 'gpt-5.4',
    apiProviderId: null,
    modelEndpointId: null,
    modelProtocol: null,
    permissionMode: 'acceptEdits',
    thinkingMode: 'high',
    agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    title: 'Forked review',
    projectPath: '/repo',
    orderGroup: 'normal',
    tags: ['cli'],
    activity: { createdAt: TIMESTAMP, lastActivityAt: TIMESTAMP, lastReadAt: null },
    preview: { firstMessage: 'Review', lastMessage: 'Review' },
    isPinned: false,
    isArchived: false,
    isActive: true,
    isProcessing: true,
    processingPhase: 'running',
    canReloadFromNativeHistory: false,
    isUnread: false,
  };
}

const command: ForkCliCommand = {
  kind: 'fork',
  workspace: 'default',
  configDir: '/config',
  sourceChatId: SOURCE_CHAT_ID,
  allowHandoffFork: true,
  json: false,
  readsMessageFromStdin: false,
};

function accepted(
  id = TARGET_CHAT_ID,
  clientRequestId = 'request-1',
): ForkRunCommandResponse {
  const forked = chat(id);
  return {
    success: true,
    commandType: 'fork-run',
    clientRequestId,
    chatId: id,
    turnId: 'turn-1',
    status: 'accepted',
    acceptedAt: TIMESTAMP,
    parentChat: forked.parentChat,
    chat: forked,
  };
}

function targetExistsResponse(chatId: string): Response {
  return Response.json({
    error: `Session already exists: ${chatId}`,
    errorCode: 'IDEMPOTENCY_CONFLICT',
    retryable: false,
  }, { status: 409 });
}

function clientOptions(fetch: typeof globalThis.fetch) {
  return {
    baseUrl: 'http://garcon.test',
    instanceId: 'instance-1',
    capability: 'capability-1',
    fetch,
  };
}

function completedReceipt(): AgentTurnReceipt {
  return {
    state: 'completed',
    chatId: TARGET_CHAT_ID,
    turnId: 'turn-1',
    clientRequestId: 'request-1',
    acceptedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    settledAt: TIMESTAMP,
    output: { availability: 'available', completeness: 'complete', text: 'Done' },
  };
}

describe('chat fork commands', () => {
  test('creates a bare fork with explicit fallback consent and retries only a definitive ID collision', async () => {
    const requests: ForkChatCommandRequest[] = [];
    const targets: string[] = [];
    const client = new GarconClient(clientOptions(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as ForkChatCommandRequest;
      requests.push(request);
      if (requests.length === 1) {
        return targetExistsResponse(request.chatId);
      }
      return Response.json({ success: true, chat: chat(request.chatId) });
    }));
    const chatIds = [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID];

    const result = await createFork(command, client, undefined, {
      createChatId: () => chatIds.shift()!,
      onTargetChatId: (chatId) => targets.push(chatId),
    });

    expect(requests).toEqual([
      { sourceChatId: SOURCE_CHAT_ID, chatId: TARGET_CHAT_ID, allowHandoffFork: true },
      { sourceChatId: SOURCE_CHAT_ID, chatId: SECOND_TARGET_CHAT_ID, allowHandoffFork: true },
    ]);
    expect(targets).toEqual([TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID]);
    expect(result.chat.id).toBe(SECOND_TARGET_CHAT_ID);
  });

  test('submits prompted forks atomically with fresh identities after a definitive collision', async () => {
    const requests: ForkRunCommandRequest[] = [];
    const client = new GarconClient(clientOptions(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as ForkRunCommandRequest;
      requests.push(request);
      if (requests.length === 1) {
        return targetExistsResponse(request.chatId);
      }
      return Response.json(accepted(request.chatId, request.clientRequestId));
    }));
    const ids = ['request-1', 'message-1', 'request-2', 'message-2'];
    const chatIds = [TARGET_CHAT_ID, SECOND_TARGET_CHAT_ID];

    const result = await submitForkRun(command, 'Review this', client, undefined, {
      createId: () => ids.shift()!,
      createChatId: () => chatIds.shift()!,
    });

    expect(requests).toEqual([
      {
        clientRequestId: 'request-1',
        clientMessageId: 'message-1',
        sourceChatId: SOURCE_CHAT_ID,
        chatId: TARGET_CHAT_ID,
        command: 'Review this',
        allowHandoffFork: true,
      },
      {
        clientRequestId: 'request-2',
        clientMessageId: 'message-2',
        sourceChatId: SOURCE_CHAT_ID,
        chatId: SECOND_TARGET_CHAT_ID,
        command: 'Review this',
        allowHandoffFork: true,
      },
    ]);
    expect(result.chatId).toBe(SECOND_TARGET_CHAT_ID);
  });

  test('does not allocate a new target for an unrelated idempotency conflict', async () => {
    let requests = 0;
    const client = new GarconClient(clientOptions(async () => {
      requests += 1;
      return Response.json({
        error: 'clientRequestId was reused with different payload',
        errorCode: 'IDEMPOTENCY_CONFLICT',
        retryable: false,
      }, { status: 409 });
    }));

    await expect(createFork(command, client, undefined, {
      createChatId: () => TARGET_CHAT_ID,
    })).rejects.toMatchObject({ errorCode: 'IDEMPOTENCY_CONFLICT' });
    expect(requests).toBe(1);
  });

  test('waits for the exact accepted fork turn', async () => {
    const receipt = completedReceipt();
    const calls: Array<[string, string]> = [];
    const client = {
      async forkChat() { throw new Error('not used'); },
      async forkRun() { throw new Error('not used'); },
      async getTurnReceipt(chatId: string, turnId: string) {
        calls.push([chatId, turnId]);
        return receipt;
      },
      async verifyRuntime() { return true; },
    } satisfies ChatForkClient;

    const result = await settleForkRun(SOURCE_CHAT_ID, accepted(), client);

    expect(calls).toEqual([[TARGET_CHAT_ID, 'turn-1']]);
    expect(result).toEqual({ sourceChatId: SOURCE_CHAT_ID, accepted: accepted(), turnReceipt: receipt });
  });

  test('rejects empty prompted content before allocating identities', async () => {
    let called = false;
    const client = {
      async forkChat() { throw new Error('not used'); },
      async forkRun() { called = true; throw new Error('not used'); },
      async getTurnReceipt() { throw new Error('not used'); },
      async verifyRuntime() { return true; },
    } satisfies ChatForkClient;

    await expect(submitForkRun(command, ' \n ', client)).rejects.toMatchObject({
      phase: 'arguments',
      exitCode: 2,
    });
    expect(called).toBe(false);
  });
});
