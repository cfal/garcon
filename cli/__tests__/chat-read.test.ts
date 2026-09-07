import { describe, expect, test } from 'bun:test';
import {
  AssistantMessage,
  BashToolUseMessage,
  ThinkingMessage,
  ToolResultMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import type {
  ChatHistoryResponse,
  ChatMessagesRequest,
  CompleteChatHistoryResponse,
  TranscriptMessage,
} from '@garcon/common/chat-view';
import type { ReadCliCommand } from '../args.js';
import {
  formatChatReadResult,
  readChatWindow,
  runChatRead,
  type ChatReadClient,
} from '../chat-read.js';
import { GarconHttpError } from '../garcon-client.js';
import type { CliOutput } from '../output.js';
import { CHAT_ID, TS } from './chat-research-fixtures.js';

const command: ReadCliCommand = {
  kind: 'read',
  workspace: 'default',
  configDir: '/config',
  chatId: CHAT_ID,
  anchorOrdinal: 250,
  beforeContext: 3,
  afterContext: 5,
  includedCategories: [],
  json: false,
};

function complete(
  request: ChatMessagesRequest,
  messages: TranscriptMessage[],
  lastOrdinal: number,
  nextBeforeOrdinal: number | null,
): CompleteChatHistoryResponse {
  const boundary = Math.min(request.beforeOrdinal ?? lastOrdinal + 1, lastOrdinal + 1);
  return {
    historyState: { kind: 'complete' },
    chatId: CHAT_ID,
    transcriptViewId: request.transcriptViewId ?? 'view-1',
    messages,
    resendCandidates: [],
    lastOrdinal,
    pageOldestOrdinal: messages[0]?.ordinal ?? 0,
    pageNewestOrdinal: boundary - 1,
    nextBeforeOrdinal,
    hasMore: nextBeforeOrdinal !== null,
    limit: request.limit ?? 50,
  };
}

function clientFor(
  respond: (request: ChatMessagesRequest) => ChatHistoryResponse,
): ChatReadClient & { requests: ChatMessagesRequest[] } {
  return {
    requests: [],
    async getChatMessages(request) {
      this.requests.push(request);
      return respond(request);
    },
  };
}

describe('chat read', () => {
  test('counts displayed conversation entries across backward and forward raw pages', async () => {
    const testClient = clientFor((request) => {
      if (request.beforeOrdinal === undefined) {
        return complete(request, [{ ordinal: 450, message: new AssistantMessage(TS, 'latest') }], 450, 450);
      }
      if (request.beforeOrdinal === 251) {
        return complete(request, [
          { ordinal: 100, message: new UserMessage(TS, 'before one') },
          { ordinal: 200, message: new AssistantMessage(TS, 'before two') },
          { ordinal: 249, message: new ThinkingMessage(TS, 'hidden reasoning') },
          { ordinal: 250, message: new AssistantMessage(TS, 'anchor') },
        ], 450, 51);
      }
      if (request.beforeOrdinal === 51) {
        return complete(request, [
          { ordinal: 10, message: new UserMessage(TS, 'old') },
          { ordinal: 50, message: new AssistantMessage(TS, 'before three') },
        ], 450, null);
      }
      if (request.beforeOrdinal === 451) {
        return complete(request, [
          { ordinal: 251, message: new BashToolUseMessage(TS, 'tool-1', 'bun test') },
          { ordinal: 252, message: new AssistantMessage(TS, 'after one') },
          { ordinal: 300, message: new ThinkingMessage(TS, 'hidden reasoning') },
          { ordinal: 400, message: new UserMessage(TS, 'after two') },
          { ordinal: 450, message: new AssistantMessage(TS, 'after three') },
        ], 450, 251);
      }
      throw new Error(`unexpected request: ${JSON.stringify(request)}`);
    });

    const result = await readChatWindow(command, testClient);

    expect(result.messages.map(({ ordinal }) => ordinal)).toEqual([
      50, 100, 200, 250, 252, 400, 450,
    ]);
    expect(testClient.requests.map(({ beforeOrdinal }) => beforeOrdinal)).toEqual([
      undefined, 251, 51, 451,
    ]);
  });

  test('advances across an all-hidden raw interval when collecting after-context', async () => {
    const testClient = clientFor((request) => {
      if (request.beforeOrdinal === undefined) {
        return complete(request, [{ ordinal: 350, message: new AssistantMessage(TS, 'latest') }], 400, 400);
      }
      if (request.beforeOrdinal === 2) {
        return complete(request, [{ ordinal: 1, message: new UserMessage(TS, 'anchor') }], 400, null);
      }
      if (request.beforeOrdinal === 202) return complete(request, [], 400, 2);
      if (request.beforeOrdinal === 401) {
        return complete(request, [{ ordinal: 350, message: new AssistantMessage(TS, 'found') }], 400, 202);
      }
      throw new Error(`unexpected request: ${JSON.stringify(request)}`);
    });

    const result = await readChatWindow({
      ...command,
      anchorOrdinal: 1,
      beforeContext: 0,
      afterContext: 1,
    }, testClient);
    expect(result.messages.map(({ ordinal }) => ordinal)).toEqual([1, 350]);
    expect(testClient.requests.map(({ beforeOrdinal }) => beforeOrdinal)).toEqual([
      undefined, 2, 202, 401,
    ]);
  });

  test('requires the category when the anchor is excluded and includes tools on request', async () => {
    const tool = { ordinal: 250, message: new BashToolUseMessage(TS, 'tool-1', 'bun test') };
    const testClient = clientFor((request) => request.beforeOrdinal === undefined
      ? complete(request, [tool], 250, 250)
      : complete(request, [tool], 250, 51));
    await expect(readChatWindow(command, testClient)).rejects.toThrow(
      'rerun with --include tool-calls',
    );

    const included = await readChatWindow({
      ...command,
      beforeContext: 0,
      afterContext: 0,
      includedCategories: ['tool-calls'],
    }, clientFor((request) => request.beforeOrdinal === undefined
      ? complete(request, [tool], 250, 250)
      : complete(request, [tool], 250, 51)));
    expect(included.messages).toEqual([tool]);
  });

  test('keeps tool results separate from tool calls', async () => {
    const toolResult = {
      ordinal: 250,
      message: new ToolResultMessage(TS, 'tool-1', { output: 'ok' }, false),
    };
    const testClient = clientFor((request) => request.beforeOrdinal === undefined
      ? complete(request, [toolResult], 250, 250)
      : complete(request, [toolResult], 250, 51));
    await expect(readChatWindow({
      ...command,
      beforeContext: 0,
      afterContext: 0,
      includedCategories: ['tool-calls'],
    }, testClient)).rejects.toThrow('--include tool-results');
  });

  test('maps stale views and formats JSON without truncating the result', async () => {
    const output = { result() {}, diagnostic() {} } as CliOutput;
    await expect(runChatRead(command, {
      async getChatMessages() {
        throw new GarconHttpError(
          'chat read',
          'stale',
          409,
          'STALE_TRANSCRIPT_VIEW',
          false,
        );
      },
    }, output)).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining('rerun search or read'),
    });

    const result = {
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      anchorOrdinal: 1,
      beforeContext: 0,
      afterContext: 0,
      includedCategories: [],
      messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'answer') }],
    };
    expect(JSON.parse(formatChatReadResult(result, true))).toEqual(result);
    expect(formatChatReadResult(result, false)).toContain('[1]');
  });
});
