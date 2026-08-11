import type { ChatMessage } from '@garcon/common/chat-types';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  attachNativeMessageSource,
  getNativeMessageSource,
} from '@garcon/server-agent-common/shared/native-message-source';
import type { CodexHistoryProfile } from '../history-profile.js';
import { sortChatMessagesByTimestamp } from '../history-loader.js';
import { CodexAppServerClient } from './client.js';
import { convertCodexAppServerItem } from './converter.js';
import { loadPaginatedUserMessageEvidence } from './paginated-user-message-evidence.js';

const TURN_PAGE_SIZE = 100;
const MAX_TURN_PAGES = 100_000;

type PaginatedProfile = Extract<CodexHistoryProfile, { mode: 'paginated' }>;

export interface CodexPaginatedHistoryClient {
  listThreadTurns: CodexAppServerClient['listThreadTurns'];
  shutdown(): void | Promise<void>;
}

export class PaginatedCodexHistorySource {
  constructor(
    private readonly profile: PaginatedProfile,
    private readonly createClient: () => CodexPaginatedHistoryClient,
    private readonly loadUserMessageEvidence = loadPaginatedUserMessageEvidence,
  ) {}

  async load(signal: AbortSignal): Promise<ChatMessage[]> {
    signal.throwIfAborted();
    const client = this.createClient();
    try {
      const messages: ChatMessage[] = [];
      const survivingTurnIds = new Set<string>();
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
          survivingTurnIds.add(turn.id);
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
      const evidence = await this.loadUserMessageEvidence(
        this.profile.nativePath,
        this.profile.createdAt,
        signal,
        survivingTurnIds,
      );
      const existingSources = new Set(messages.flatMap((message) => {
        const entryId = getNativeMessageSource(message)?.entryId;
        return entryId ? [entryId] : [];
      }));
      const existingRequestIds = new Set(messages.flatMap((message) => {
        const requestId = upstreamRequestId(message);
        return requestId ? [requestId] : [];
      }));
      return sortChatMessagesByTimestamp([
        ...messages,
        ...evidence.filter((message) => {
          const sourceId = getNativeMessageSource(message)?.entryId;
          const requestId = upstreamRequestId(message);
          return !(sourceId && existingSources.has(sourceId))
            && !(requestId && existingRequestIds.has(requestId));
        }),
      ]);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AgentIntegrationError) throw error;
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'Codex paginated history is unavailable',
        true,
        {
          operation: 'load-paginated-history',
          provider: 'codex',
          reason: 'provider-error',
        },
      );
    } finally {
      await client.shutdown();
    }
  }

}

function codexTimestamp(value: number | null, fallback: string): string {
  if (value === null || !Number.isFinite(value) || value < 0) return fallback;
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  const timestamp = new Date(milliseconds);
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString();
}

function upstreamRequestId(message: ChatMessage): string | null {
  if (!('metadata' in message)) return null;
  const value = message.metadata?.upstreamRequestId;
  return typeof value === 'string' && value ? value : null;
}
