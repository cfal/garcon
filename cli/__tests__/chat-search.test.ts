import { describe, expect, test } from 'bun:test';
import type { ChatSearchResponse } from '@garcon/common/chat-search';
import { BashToolUseMessage, ThinkingMessage } from '@garcon/common/chat-types';
import type { ChatMessagesRequest, TranscriptMessage } from '@garcon/common/chat-view';
import { parseCliArgs, type ReadCliCommand, type SearchCliCommand } from '../args.js';
import {
  buildSearchReadCommandArguments,
  buildChatSearchRequest,
  buildChatSearchResult,
  formatChatSearchResult,
  runChatSearch,
  searchDiagnostics,
} from '../chat-search.js';
import { readChatWindow } from '../chat-read.js';
import { CliError } from '../errors.js';
import { GarconHttpError } from '../garcon-client.js';
import type { CliOutput } from '../output.js';
import { CHAT_ID, OTHER_CHAT_ID, TS, chat, chatList } from './chat-research-fixtures.js';

const command: SearchCliCommand = {
  kind: 'search',
  workspace: 'default',
  configDir: '/config',
  query: '"version bump"',
  filter: '',
  sort: 'relevance',
  limit: 20,
  offset: 0,
  snippetLimit: 3,
  json: false,
};

function response(overrides: Partial<ChatSearchResponse> = {}): ChatSearchResponse {
  return {
    query: command.query,
    mode: 'page',
    snippetLimit: 3,
    results: [{
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      score: 2,
      matchedMessageCount: 1,
      snippets: [{ ordinal: 84, role: 'assistant', timestamp: TS, text: 'version bump' }],
    }, {
      chatId: OTHER_CHAT_ID,
      transcriptViewId: 'view-2',
      score: 1,
      matchedMessageCount: 1,
      snippets: [],
    }],
    page: { offset: 0, limit: 20, total: 2, hasMore: false, nextOffset: null },
    index: {
      indexedChatCount: 2,
      pendingChatCount: 0,
      failedChatCount: 0,
      unindexedChatCount: 0,
      unsupportedChatCount: 0,
      resultsTruncated: false,
      failedChats: [],
      failedChatsOmittedCount: 0,
    },
    removedStaleResultCount: 0,
    ...overrides,
  };
}

describe('chat search', () => {
  test('omits chatIds without a metadata filter and restricts filtered searches', () => {
    const chats = chatList([
      chat(),
      chat({ id: OTHER_CHAT_ID, agentId: 'claude', agentSettings: {
        ownerId: 'claude', schemaVersion: 1, values: {},
      } }),
    ]);
    const unfiltered = buildChatSearchRequest(command, chats);
    expect(unfiltered.request).not.toHaveProperty('chatIds');
    expect(unfiltered.candidateChatCount).toBe(2);

    const filtered = buildChatSearchRequest({ ...command, filter: 'agent:codex' }, chats);
    expect(filtered.request.chatIds).toEqual([CHAT_ID]);
    expect(filtered.candidateChatCount).toBe(1);
  });

  test('uses the shared parent and date filters for transcript candidate admission', () => {
    const child = chat({
      id: CHAT_ID,
      parentChat: { chatId: OTHER_CHAT_ID, relation: 'delegation' },
      activity: {
        createdAt: '2026-09-01T00:00:00.000Z',
        lastActivityAt: '2026-09-03T00:00:00.000Z',
        lastReadAt: null,
      },
    });
    const unrelated = chat({ id: '1785337200123458' });
    const filtered = buildChatSearchRequest({
      ...command,
      filter: `parent:${OTHER_CHAT_ID} created-before:2026-09-02 updated-after:2026-09-02`,
    }, chatList([unrelated, child]));

    expect(filtered.request.chatIds).toEqual([CHAT_ID]);
    expect(filtered.candidateChatCount).toBe(1);
  });

  test('fails instead of chunking filters over the server candidate bound', () => {
    const sessions = Array.from({ length: 10_001 }, (_, index) => chat({
      id: String(1_785_337_200_000_000 + index),
    }));
    expect(() => buildChatSearchRequest({ ...command, filter: 'project:/garcon' }, chatList(sessions)))
      .toThrow('narrow it to 10000 or fewer');
  });

  test('joins available metadata and retains hits missing from the list snapshot', () => {
    const result = buildChatSearchResult(command, chatList([chat()]), response(), 1);
    expect(result.results[0]?.chat).toMatchObject({ chatId: CHAT_ID, title: 'Search work' });
    expect(result.results[1]?.chat).toBeNull();
    expect(result.interpretedQuery.clauses[0]?.kind).toBe('phrase');
    expect(JSON.parse(formatChatSearchResult(result, true, command))).toEqual(result);
    expect(formatChatSearchResult(result, false, command)).toContain(
      `garcon-cli --workspace 'default' --config-dir '/config' read '${CHAT_ID}' '84' --transcript-view-id 'view-1' --include 'reasoning'`,
    );
  });

  test('preserves and shell-quotes connection selection in read commands', () => {
    const connectedCommand: SearchCliCommand = {
      ...command,
      workspace: "research'archive",
      configDir: "/config/with space/it's",
      serverUrl: 'https://garcon.example.test:8443',
    };
    const result = buildChatSearchResult(
      connectedCommand,
      chatList([chat()]),
      response(),
      1,
    );
    expect(formatChatSearchResult(result, false, connectedCommand)).toContain(
      `garcon-cli --workspace 'research'"'"'archive' --config-dir '/config/with space/it'"'"'s' --server 'https://garcon.example.test:8443' read '${CHAT_ID}' '84' --transcript-view-id 'view-1' --include 'reasoning'`,
    );
  });

  test('generates read arguments that retain every coarse search role', () => {
    const expectations = [
      { role: 'user' as const, includedCategories: [] },
      { role: 'assistant' as const, includedCategories: ['reasoning'] },
      { role: 'tool' as const, includedCategories: ['tool-calls', 'tool-results', 'permissions'] },
      { role: 'system' as const, includedCategories: ['handoffs'] },
    ];
    for (const expectation of expectations) {
      const result = buildChatSearchResult(command, chatList([chat()]), response({
        results: [{
          chatId: CHAT_ID,
          transcriptViewId: 'view-1',
          score: 2,
          matchedMessageCount: 1,
          snippets: [{
            ordinal: 84,
            role: expectation.role,
            timestamp: TS,
            text: 'match',
          }],
        }],
        page: { offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null },
      }), 1);
      const hit = result.results[0]!;
      const parsed = parseCliArgs(buildSearchReadCommandArguments(command, hit, hit.snippets[0]!));
      expect(parsed).toMatchObject({
        kind: 'read',
        includedCategories: expectation.includedCategories,
      });
    }
  });

  test.each([
    {
      role: 'assistant' as const,
      message: new ThinkingMessage(TS, 'reasoning match'),
    },
    {
      role: 'tool' as const,
      message: new BashToolUseMessage(TS, 'tool-1', 'bun test'),
    },
  ])('generated $role read arguments can read a hidden-category anchor', async ({ role, message }) => {
    const result = buildChatSearchResult(command, chatList([chat()]), response({
      results: [{
        chatId: CHAT_ID,
        transcriptViewId: 'view-1',
        score: 2,
        matchedMessageCount: 1,
        snippets: [{ ordinal: 84, role, timestamp: TS, text: 'match' }],
      }],
      page: { offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null },
    }), 1);
    const hit = result.results[0]!;
    const parsed = parseCliArgs(
      buildSearchReadCommandArguments(command, hit, hit.snippets[0]!),
    ) as ReadCliCommand;
    const entry: TranscriptMessage = { ordinal: 84, message };
    await expect(readChatWindow(parsed, {
      async getChatMessages(request: ChatMessagesRequest) {
        return {
          historyState: { kind: 'complete' as const },
          chatId: CHAT_ID,
          transcriptViewId: request.transcriptViewId ?? 'view-1',
          messages: [entry],
          resendCandidates: [],
          lastOrdinal: 84,
          pageOldestOrdinal: 84,
          pageNewestOrdinal: 84,
          nextBeforeOrdinal: null,
          hasMore: false,
          limit: request.limit ?? 50,
        };
      },
    })).resolves.toMatchObject({ messages: [entry] });
  });

  test('reports every incomplete-coverage and paging condition', () => {
    const result = buildChatSearchResult(command, chatList([chat()]), response({
      results: [],
      page: { offset: 0, limit: 20, total: 30, hasMore: true, nextOffset: 20 },
      index: {
        indexedChatCount: 1,
        pendingChatCount: 2,
        failedChatCount: 3,
        unindexedChatCount: 4,
        unsupportedChatCount: 5,
        resultsTruncated: true,
        failedChats: [{
          chatId: CHAT_ID,
          transcriptViewId: null,
          stage: 'adoption',
          errorCode: 'TRANSCRIPT_UNAVAILABLE',
          indexedThroughOrdinal: null,
          targetThroughOrdinal: null,
          recovery: 'source-required',
        }, {
          chatId: OTHER_CHAT_ID,
          transcriptViewId: 'view-2',
          stage: 'indexing',
          errorCode: 'SEARCH_INDEX_FAILED',
          indexedThroughOrdinal: 10,
          targetThroughOrdinal: 20,
          recovery: 'index-retry',
        }],
        failedChatsOmittedCount: 1,
      },
    }), 15);
    const diagnostics = searchDiagnostics(result).join('\n');
    expect(diagnostics).toContain('pending rows');
    expect(diagnostics).toContain('failed indexing');
    expect(diagnostics).toContain('not indexed');
    expect(diagnostics).toContain('unsupported');
    expect(diagnostics).toContain('matches and total may be incomplete');
    expect(diagnostics).toContain('--offset 20');
    expect(diagnostics).toContain(`chat ${CHAT_ID}; adoption; TRANSCRIPT_UNAVAILABLE`);
    expect(diagnostics).toContain('1 additional failed chats omitted');
    expect(diagnostics).not.toContain('search complete');
  });

  test('prints an explicit complete zero-result diagnostic', () => {
    const result = buildChatSearchResult(command, chatList([]), response({
      results: [],
      page: { offset: 0, limit: 20, total: 0, hasMore: false, nextOffset: null },
      index: {
        indexedChatCount: 0,
        pendingChatCount: 0,
        failedChatCount: 0,
        unindexedChatCount: 0,
        unsupportedChatCount: 0,
        resultsTruncated: false,
        failedChats: [],
        failedChatsOmittedCount: 0,
      },
    }), 0);
    expect(searchDiagnostics(result)).toEqual([
      'search complete: no matching indexed transcript content',
    ]);
  });

  test.each([
    {
      page: { offset: 20, limit: 20, total: 1, hasMore: false, nextOffset: null },
      expected: '--offset 20 is beyond 1 matching chats',
    },
    {
      page: { offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null },
      expected: 'no current results were returned despite 1 matching chats',
    },
  ])('does not claim absence for an empty positive-total page', ({ page, expected }) => {
    const result = buildChatSearchResult(command, chatList([]), response({
      results: [],
      page,
    }), 0);
    const diagnostics = searchDiagnostics(result);
    expect(diagnostics).toContainEqual(expect.stringContaining(expected));
    expect(diagnostics.join('\n')).not.toContain('no matching indexed transcript content');
  });

  test('warns when part of a page is removed as stale without changing the server cursor', () => {
    const result = buildChatSearchResult(command, chatList([chat()]), response({
      results: [response().results[0]!],
      page: { offset: 0, limit: 20, total: 25, hasMore: true, nextOffset: 20 },
      removedStaleResultCount: 1,
    }), 1);

    expect(result.page).toEqual({
      offset: 0, limit: 20, total: 25, hasMore: true, nextOffset: 20,
    });
    expect(searchDiagnostics(result)).toEqual(expect.arrayContaining([
      expect.stringContaining('1 stale result removed after paging'),
      expect.stringContaining('--offset 20'),
    ]));
  });

  test('maps disabled search to an actionable argument error', async () => {
    const output = { result() {}, diagnostic() {} } as CliOutput;
    await expect(runChatSearch(command, {
      async listChats() { return chatList([]); },
      async searchChats() {
        throw new GarconHttpError(
          'chat search',
          'disabled',
          409,
          'TRANSCRIPT_SEARCH_DISABLED',
          false,
        );
      },
    }, output)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('garcon-cli transcript-search enable'),
    } satisfies Partial<CliError>);
  });

  test('preserves retryable index unavailability as an operational failure', async () => {
    const output = { result() {}, diagnostic() {} } as CliOutput;
    await expect(runChatSearch(command, {
      async listChats() { return chatList([]); },
      async searchChats() {
        throw new GarconHttpError(
          'chat search',
          'temporarily unavailable',
          503,
          'SEARCH_INDEX_UNAVAILABLE',
          true,
        );
      },
    }, output)).rejects.toMatchObject({
      exitCode: 3,
      message: 'temporarily unavailable',
    } satisfies Partial<CliError>);
  });

  test('maps search timeouts to an actionable incomplete-coverage diagnostic', async () => {
    const output = { result() {}, diagnostic() {} } as CliOutput;
    await expect(runChatSearch(command, {
      async listChats() { return chatList([]); },
      async searchChats() {
        throw new GarconHttpError(
          'chat search',
          'timed out',
          503,
          'SEARCH_TIMEOUT',
          true,
        );
      },
    }, output)).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining('timed out before coverage could be reported'),
    } satisfies Partial<CliError>);
  });
});
