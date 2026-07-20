import type { ChatMessage } from '@garcon/common/chat-types';
import { AgentIntegrationError, type AgentTranscriptPage, type AgentTranscriptPreview } from '@garcon/server-agent-interface';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { transcriptRevision } from '@garcon/server-agent-common/lib/transcript-revision';
import type { CodexHistoryProfile } from '../history-profile.js';
import { pageFromMessages } from '../history-loader.js';
import { CodexAppServerClient } from './client.js';
import { convertCodexAppServerItem } from './converter.js';

const TURN_PAGE_SIZE = 100;
const MAX_TURN_PAGES = 100_000;

type PaginatedProfile = Extract<CodexHistoryProfile, { mode: 'paginated' }>;

export interface CodexPaginatedHistoryClient {
  listThreadTurns: CodexAppServerClient['listThreadTurns'];
  shutdown(): void;
}

export class PaginatedCodexHistorySource {
  constructor(
    private readonly profile: PaginatedProfile,
    private readonly createClient: () => CodexPaginatedHistoryClient,
  ) {}

  async load(signal: AbortSignal): Promise<ChatMessage[]> {
    signal.throwIfAborted();
    const client = this.createClient();
    try {
      const messages: ChatMessage[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        signal.throwIfAborted();
        const response = await client.listThreadTurns({
          threadId: this.profile.threadId,
          cursor,
          limit: TURN_PAGE_SIZE,
          sortDirection: 'asc',
          itemsView: 'full',
        });
        signal.throwIfAborted();
        for (const turn of response.data) {
          if (turn.itemsView !== 'full') {
            throw new Error(`Codex returned ${turn.itemsView} items for turn ${turn.id}`);
          }
          const timestamp = codexTimestamp(turn.startedAt ?? turn.completedAt, this.profile.createdAt);
          for (const item of turn.items) {
            const converted = convertCodexAppServerItem(item, timestamp, { includeUserMessages: true });
            converted.forEach((message, withinSourceOrdinal) => {
              messages.push(attachNativeMessageSource(message, {
                entryId: `turn:${turn.id}:item:${item.id}`,
                withinSourceOrdinal,
              }));
            });
          }
        }
        cursor = response.nextCursor;
        if (cursor && seenCursors.has(cursor)) {
          throw new Error(`Codex repeated history cursor ${cursor}`);
        }
        if (cursor) seenCursors.add(cursor);
        pageCount += 1;
        if (cursor && pageCount >= MAX_TURN_PAGES) {
          throw new Error('Codex paginated history exceeded the page limit');
        }
      } while (cursor);
      return messages;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AgentIntegrationError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        `Codex paginated history is unavailable: ${message}`,
        true,
      );
    } finally {
      client.shutdown();
    }
  }

  async loadPage(
    page: { readonly limit: number; readonly offset: number },
    signal: AbortSignal,
  ): Promise<AgentTranscriptPage | null> {
    if (!validPage(page)) return null;
    return pageFromMessages(await this.load(signal), page.limit, page.offset);
  }

  async preview(signal: AbortSignal): Promise<AgentTranscriptPreview | null> {
    const messages = await this.load(signal);
    const conversational = messages.filter((message) => (
      message.type === 'user-message' || message.type === 'assistant-message'
    ));
    const first = conversational[0];
    if (!first || typeof first.content !== 'string') return null;
    const last = conversational[conversational.length - 1] ?? first;
    const lastActivity = [...messages].reverse().find((message) => (
      typeof message.timestamp === 'string'
    ));
    return {
      firstMessage: first.content,
      lastMessage: typeof last.content === 'string' ? last.content : first.content,
      createdAt: this.profile.createdAt,
      lastActivity: lastActivity?.timestamp ?? this.profile.createdAt,
    };
  }

  async revision(signal: AbortSignal): Promise<string> {
    return transcriptRevision(await this.load(signal));
  }
}

function codexTimestamp(value: number | null, fallback: string): string {
  if (value === null || !Number.isFinite(value) || value < 0) return fallback;
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  const timestamp = new Date(milliseconds);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function validPage(page: { readonly limit: number; readonly offset: number }): boolean {
  return Number.isSafeInteger(page.limit)
    && page.limit > 0
    && Number.isSafeInteger(page.offset)
    && page.offset >= 0
    && page.offset <= Number.MAX_SAFE_INTEGER - page.limit;
}
