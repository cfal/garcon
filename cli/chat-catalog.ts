import {
  matchesChatFilter,
  parseChatFilterQuery,
  type ChatFilterSpec,
} from '@garcon/common/client/chat-filter-query';
import type { ChatListEntry, ChatListResponse } from '@garcon/common/chat-list';
import { chatActivityTimeMs } from '@garcon/common/chat-order-sort';
import type { ChatsCliCommand } from './args.js';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';
import { formatTextTable } from './text-table.js';

export interface CliChatSummary {
  readonly chatId: string;
  readonly parentChatId: string | null;
  readonly parentRelation: 'fork' | 'handoff' | 'delegation' | null;
  readonly title: string;
  readonly projectPath: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly providerId: string | null;
  readonly endpointId: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly isProcessing: boolean;
  readonly isUnread: boolean;
}

export interface CliChatPage {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

export interface CliChatCatalogResult {
  readonly filter: string;
  readonly page: CliChatPage;
  readonly chats: readonly CliChatSummary[];
}

export interface ChatCatalogClient {
  listChats(signal?: AbortSignal): Promise<ChatListResponse>;
}

export function parseCliChatFilter(filter: string): ChatFilterSpec {
  const parsed = parseChatFilterQuery(filter);
  if (parsed.invalidTokens.length > 0) {
    throw new CliError(
      'arguments',
      `invalid chat filter token: ${parsed.invalidTokens[0]}`,
      2,
    );
  }
  return parsed.spec;
}

export function filterAndSortChats(
  chats: readonly ChatListEntry[],
  filter: ChatFilterSpec,
): ChatListEntry[] {
  return chats
    .filter((chat) => matchesChatFilter({
      ...chat,
      firstMessage: chat.preview.firstMessage,
      lastMessage: chat.preview.lastMessage,
    }, filter))
    .sort((left, right) => {
      const timeDifference = chatActivityTimeMs({ id: right.id, ...right.activity })
        - chatActivityTimeMs({ id: left.id, ...left.activity });
      return timeDifference || left.id.localeCompare(right.id);
    });
}

export function projectCliChat(chat: ChatListEntry): CliChatSummary {
  return {
    chatId: chat.id,
    parentChatId: chat.parentChat?.chatId ?? null,
    parentRelation: chat.parentChat?.relation ?? null,
    title: chat.title,
    projectPath: chat.projectPath,
    agentId: chat.agentId,
    model: chat.model,
    providerId: chat.apiProviderId ?? null,
    endpointId: chat.modelEndpointId ?? null,
    tags: [...chat.tags],
    createdAt: chat.activity.createdAt,
    lastActivityAt: chat.activity.lastActivityAt,
    isPinned: chat.isPinned,
    isArchived: chat.isArchived,
    isProcessing: chat.isProcessing,
    isUnread: chat.isUnread,
  };
}

export function buildChatCatalogResult(
  command: Pick<ChatsCliCommand, 'filter' | 'limit' | 'offset'>,
  response: ChatListResponse,
): CliChatCatalogResult {
  const matches = filterAndSortChats(response.sessions, parseCliChatFilter(command.filter));
  const chats = matches
    .slice(command.offset, command.offset + command.limit)
    .map(projectCliChat);
  const nextOffset = command.offset + chats.length;
  const hasMore = nextOffset < matches.length;
  return {
    filter: command.filter,
    page: {
      offset: command.offset,
      limit: command.limit,
      total: matches.length,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    },
    chats,
  };
}

export function formatChatCatalogResult(result: CliChatCatalogResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const table = formatTextTable(
    ['ACTIVITY', 'CHAT', 'AGENT', 'PROJECT', 'TITLE'],
    result.chats.map((chat) => [
      chat.lastActivityAt ?? chat.createdAt ?? '',
      chat.chatId,
      chat.agentId,
      chat.projectPath,
      chat.title,
    ]),
  );
  if (result.chats.length === 0) return `${table}\n\nshowing 0 of ${result.page.total}`;
  const shownThrough = result.page.offset + result.chats.length;
  return `${table}\n\nshowing ${result.page.offset + 1}-${shownThrough} of ${result.page.total}`;
}

export async function runChatCatalog(
  command: ChatsCliCommand,
  client: ChatCatalogClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const result = buildChatCatalogResult(command, await client.listChats(signal));
  output.result(formatChatCatalogResult(result, command.json));
}
