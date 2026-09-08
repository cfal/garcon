import {
  CHAT_SEARCH_MAX_CHAT_IDS,
  compileChatSearchQuery,
  type ChatSearchIndexStatus,
  type ChatSearchPage,
  type ChatSearchQueryV1,
  type ChatSearchRequest,
  type ChatSearchResponse,
  type ChatSearchResult,
  type ChatSearchSnippet,
  type ChatSearchSort,
} from '@garcon/common/chat-search';
import { isEmptyFilter } from '@garcon/common/client/chat-filter-query';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { CliConnectionOptions, SearchCliCommand } from './args.js';
import {
  filterAndSortChats,
  parseCliChatFilter,
  projectCliChat,
  type CliChatSummary,
} from './chat-catalog.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';

export interface CliChatSearchHit extends ChatSearchResult {
  readonly chat: CliChatSummary | null;
}

export interface CliChatSearchResult {
  readonly query: string;
  readonly filter: string;
  readonly sort: ChatSearchSort;
  readonly interpretedQuery: ChatSearchQueryV1;
  readonly candidateChatCount: number;
  readonly page: ChatSearchPage;
  readonly index: ChatSearchIndexStatus;
  readonly results: readonly CliChatSearchHit[];
}

export interface ChatSearchClient {
  listChats(signal?: AbortSignal): Promise<ChatListResponse>;
  searchChats(request: ChatSearchRequest, signal?: AbortSignal): Promise<ChatSearchResponse>;
}

export function buildChatSearchRequest(
  command: SearchCliCommand,
  chats: ChatListResponse,
): { readonly request: ChatSearchRequest; readonly candidateChatCount: number } {
  const filter = parseCliChatFilter(command.filter);
  const hasFilter = !isEmptyFilter(filter);
  const filtered = hasFilter
    ? filterAndSortChats(chats.sessions, filter)
    : chats.sessions;
  if (hasFilter && filtered.length > CHAT_SEARCH_MAX_CHAT_IDS) {
    throw new CliError(
      'arguments',
      `chat filter selected ${filtered.length} chats; narrow it to ${CHAT_SEARCH_MAX_CHAT_IDS} or fewer`,
      2,
    );
  }
  return {
    request: {
      query: command.query,
      sort: command.sort,
      mode: 'page',
      offset: command.offset,
      limit: command.limit,
      snippetLimit: command.snippetLimit,
      ...(hasFilter ? { chatIds: filtered.map((chat) => chat.id) } : {}),
    },
    candidateChatCount: filtered.length,
  };
}

export function buildChatSearchResult(
  command: SearchCliCommand,
  chats: ChatListResponse,
  response: ChatSearchResponse,
  candidateChatCount: number,
): CliChatSearchResult {
  const chatsById = new Map(chats.sessions.map((chat) => [chat.id, chat]));
  return {
    query: response.query,
    filter: command.filter,
    sort: command.sort,
    interpretedQuery: compileChatSearchQuery(command.query),
    candidateChatCount,
    page: response.page,
    index: response.index,
    results: response.results.map((result) => {
      const chat = chatsById.get(result.chatId);
      return { ...result, chat: chat ? projectCliChat(chat) : null };
    }),
  };
}

export function formatChatSearchResult(
  result: CliChatSearchResult,
  json: boolean,
  connection: CliConnectionOptions,
): string {
  if (json) return JSON.stringify(result, null, 2);
  const lines = [
    `query: ${result.query}`,
    `interpreted as: ${formatInterpretedQuery(result.interpretedQuery)}`,
    `candidates: ${result.candidateChatCount}`,
    `matches: ${result.page.total}`,
  ];
  for (const hit of result.results) {
    const chat = hit.chat;
    lines.push(
      '',
      `chat id: ${hit.chatId}`,
      `title: ${chat?.title ?? '[metadata unavailable]'}`,
      `project path: ${chat?.projectPath ?? '[metadata unavailable]'}`,
      `agent: ${chat?.agentId ?? '[metadata unavailable]'}`,
      `chat activity: ${chat?.lastActivityAt ?? chat?.createdAt ?? 'unknown'}`,
      `matched rows (sampled): ${hit.matchedMessageCount}`,
    );
    for (const snippet of hit.snippets) {
      const text = snippet.text.replace(/\s+/g, ' ').trim();
      lines.push(`  [${snippet.ordinal}] ${snippet.role} ${snippet.timestamp ?? 'unknown'} ${text}`);
    }
    const anchor = hit.snippets[0];
    if (anchor) {
      lines.push(`  read: ${formatReadCommand(connection, hit, anchor)}`);
    }
  }
  return lines.join('\n');
}

export function searchDiagnostics(result: CliChatSearchResult): string[] {
  const diagnostics: string[] = [];
  if (result.index.pendingChatCount > 0) {
    diagnostics.push(
      `search coverage: ${result.index.pendingChatCount} candidate chats have pending rows; recent messages may be missing`,
    );
  }
  if (result.index.failedChatCount > 0) {
    diagnostics.push(
      `search coverage: ${result.index.failedChatCount} candidate chats failed indexing`,
    );
  }
  if (result.index.unindexedChatCount > 0) {
    diagnostics.push(
      `search coverage: ${result.index.unindexedChatCount} candidate chats are not indexed`,
    );
  }
  if (result.index.unsupportedChatCount > 0) {
    diagnostics.push(
      `search coverage: ${result.index.unsupportedChatCount} candidate chats are unsupported`,
    );
  }
  if (result.index.resultsTruncated) {
    diagnostics.push(
      'search coverage: index row sampling truncated this query; matches and total may be incomplete; narrow the metadata filter or quote a phrase',
    );
  }
  if (result.page.hasMore) {
    diagnostics.push(`search page: more matches are available at --offset ${result.page.nextOffset}`);
  }
  if (result.results.length === 0 && result.page.total > 0) {
    if (result.page.offset >= result.page.total) {
      diagnostics.push(
        `search page: --offset ${result.page.offset} is beyond ${result.page.total} matching chats; retry with a lower offset`,
      );
    } else {
      diagnostics.push(
        `search page: no current results were returned despite ${result.page.total} matching chats; rerun search because transcript views may have changed`,
      );
    }
  } else if (result.page.total === 0 && diagnostics.length === 0) {
    diagnostics.push('search complete: no matching indexed transcript content');
  }
  return diagnostics;
}

export async function runChatSearch(
  command: SearchCliCommand,
  client: ChatSearchClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const chats = await client.listChats(signal);
  const { request, candidateChatCount } = buildChatSearchRequest(command, chats);
  let response: ChatSearchResponse;
  try {
    response = await client.searchChats(request, signal);
  } catch (error) {
    if (error instanceof GarconHttpError && error.errorCode === 'TRANSCRIPT_SEARCH_DISABLED') {
      throw new CliError(
        'chat search',
        'transcript search is disabled; enable features.transcriptSearch.enabled in Garcon settings',
        2,
        { cause: error },
      );
    }
    throw error;
  }
  const result = buildChatSearchResult(command, chats, response, candidateChatCount);
  output.result(formatChatSearchResult(result, command.json, command));
  for (const diagnostic of searchDiagnostics(result)) output.diagnostic(diagnostic);
}

function formatReadCommand(
  connection: CliConnectionOptions,
  hit: CliChatSearchHit,
  anchor: ChatSearchSnippet,
): string {
  return ['garcon-cli', ...searchReadCommandTokens(connection, hit, anchor).map((token) => (
    token.syntax ? token.value : shellQuote(token.value)
  ))].join(' ');
}

interface SearchReadCommandToken {
  readonly value: string;
  readonly syntax: boolean;
}

export function buildSearchReadCommandArguments(
  connection: CliConnectionOptions,
  hit: CliChatSearchHit,
  anchor: ChatSearchSnippet,
): string[] {
  return searchReadCommandTokens(connection, hit, anchor).map(({ value }) => value);
}

function searchReadCommandTokens(
  connection: CliConnectionOptions,
  hit: CliChatSearchHit,
  anchor: ChatSearchSnippet,
): SearchReadCommandToken[] {
  const syntax = (value: string): SearchReadCommandToken => ({ value, syntax: true });
  const data = (value: string): SearchReadCommandToken => ({ value, syntax: false });
  const includedCategories = readIncludesForSearchRole(anchor.role);
  return [
    syntax('--workspace'),
    data(connection.workspace),
    syntax('--config-dir'),
    data(connection.configDir),
    ...(connection.serverUrl === undefined
      ? []
      : [syntax('--server'), data(connection.serverUrl)]),
    syntax('read'),
    data(hit.chatId),
    data(String(anchor.ordinal)),
    syntax('--transcript-view-id'),
    data(hit.transcriptViewId),
    ...(includedCategories === null
      ? []
      : [syntax('--include'), data(includedCategories)]),
  ];
}

function readIncludesForSearchRole(role: ChatSearchSnippet['role']): string | null {
  switch (role) {
    case 'assistant':
      return 'reasoning';
    case 'tool':
      return 'tools,permissions';
    case 'system':
      return 'handoffs';
    case 'user':
      return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatInterpretedQuery(query: ChatSearchQueryV1): string {
  return query.clauses.map((clause) => {
    const tokens = clause.tokens.map((token) => (
      token.match === 'prefix' ? `${token.normalized}*` : token.normalized
    ));
    return clause.kind === 'phrase' ? `"${tokens.join(' ')}"` : tokens.join(' & ');
  }).join(' AND ') || '[no searchable words]';
}
