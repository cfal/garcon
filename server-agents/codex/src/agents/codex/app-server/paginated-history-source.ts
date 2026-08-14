import type { ChatMessage } from '@garcon/common/chat-types';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  attachNativeMessageSource,
  getNativeMessageSource,
} from '@garcon/server-agent-common/shared/native-message-source';
import type { CodexHistoryProfile } from '../history-profile.js';
import { CodexAppServerClient } from './client.js';
import { convertCodexAppServerItem } from './converter.js';
import { loadPaginatedUserMessageEvidence } from './paginated-user-message-evidence.js';

const TURN_PAGE_SIZE = 100;
const MAX_TURN_PAGES = 100_000;

type PaginatedProfile = Extract<CodexHistoryProfile, { mode: 'paginated' }>;

interface PaginatedTurnItemMessages {
  readonly itemId: string;
  readonly messages: ChatMessage[];
}

interface PaginatedTurnMessages {
  readonly turnId: string;
  readonly items: PaginatedTurnItemMessages[];
}

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
      const turnMessages: PaginatedTurnMessages[] = [];
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
            throw new Error(
              `Codex returned ${turn.itemsView} items for turn ${turn.id}`,
            );
          }
          survivingTurnIds.add(turn.id);
          const timestamp = codexTimestamp(
            turn.startedAt ?? turn.completedAt,
            this.profile.createdAt,
          );
          const items: PaginatedTurnItemMessages[] = [];
          for (const item of turn.items) {
            const converted = convertCodexAppServerItem(item, timestamp, {
              includeUserMessages: true,
            });
            items.push({
              itemId: item.id,
              messages: converted.map((message, withinSourceOrdinal) =>
                attachNativeMessageSource(message, {
                  entryId: `turn:${turn.id}:item:${item.id}`,
                  withinSourceOrdinal,
                }),
              ),
            });
          }
          turnMessages.push({ turnId: turn.id, items });
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
      const claimedRequestIds = collectUpstreamRequestIds(turnMessages);
      return turnMessages.flatMap((turn) =>
        mergeTurnEvidence(
          turn,
          evidence.messages,
          evidence.orderedItemIdsByTurn.get(turn.turnId),
          claimedRequestIds,
        ),
      );
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

function mergeTurnEvidence(
  turn: PaginatedTurnMessages,
  evidenceMessages: readonly ChatMessage[],
  orderedItemIds: readonly string[] | undefined,
  claimedRequestIds: Set<string>,
): ChatMessage[] {
  const providerItemIndex = new Map(
    turn.items.map((item, index) => [item.itemId, index]),
  );
  const orderedEvidenceIds = orderedItemIds ?? [];
  let lastEvidenceProviderIndex = -1;
  for (const itemId of orderedEvidenceIds) {
    const providerIndex = providerItemIndex.get(itemId);
    if (providerIndex === undefined) continue;
    if (providerIndex <= lastEvidenceProviderIndex) {
      throw new Error(
        `Codex item evidence conflicts with provider order for turn ${turn.turnId}`,
      );
    }
    lastEvidenceProviderIndex = providerIndex;
  }

  const evidenceMessagesByItemId = new Map<string, ChatMessage[]>();
  for (const message of evidenceMessages) {
    const itemId = sourceItemId(
      getNativeMessageSource(message)?.entryId,
      turn.turnId,
    );
    if (!itemId || providerItemIndex.has(itemId)) continue;
    const requestId = upstreamRequestId(message);
    if (requestId && claimedRequestIds.has(requestId)) continue;
    if (requestId) claimedRequestIds.add(requestId);
    const itemMessages = evidenceMessagesByItemId.get(itemId) ?? [];
    itemMessages.push(message);
    evidenceMessagesByItemId.set(itemId, itemMessages);
  }

  if (!evidenceMessagesByItemId.size) {
    return turn.items.flatMap((item) => item.messages);
  }

  if (turn.items.length === 0) {
    return orderedEvidenceIds.flatMap(
      (itemId) => evidenceMessagesByItemId.get(itemId) ?? [],
    );
  }

  const sharedEvidenceIndexes = orderedEvidenceIds.flatMap((itemId, evidenceIndex) => {
    const providerIndex = providerItemIndex.get(itemId);
    return providerIndex === undefined ? [] : [{ evidenceIndex, providerIndex }];
  });
  if (sharedEvidenceIndexes.length === 0) {
    throw new Error(
      `Codex item evidence has no provider anchor for turn ${turn.turnId}`,
    );
  }

  const evidenceByProviderInsertionIndex = new Map<number, ChatMessage[]>();
  for (const [evidenceIndex, itemId] of orderedEvidenceIds.entries()) {
    const messages = evidenceMessagesByItemId.get(itemId);
    if (!messages) continue;
    const previousAnchor = sharedEvidenceIndexes.findLast(
      (anchor) => anchor.evidenceIndex < evidenceIndex,
    );
    const nextAnchor = sharedEvidenceIndexes.find(
      (anchor) => anchor.evidenceIndex > evidenceIndex,
    );
    const insertionIndex = nextAnchor?.providerIndex ?? turn.items.length;
    const providerGapStart = (previousAnchor?.providerIndex ?? -1) + 1;
    if (providerGapStart !== insertionIndex) {
      throw new Error(
        `Codex item evidence has an ambiguous position for turn ${turn.turnId}`,
      );
    }
    const positioned = evidenceByProviderInsertionIndex.get(insertionIndex) ?? [];
    positioned.push(...messages);
    evidenceByProviderInsertionIndex.set(insertionIndex, positioned);
  }

  const merged = turn.items.flatMap((item, index) => [
    ...(evidenceByProviderInsertionIndex.get(index) ?? []),
    ...item.messages,
  ]);
  merged.push(...(evidenceByProviderInsertionIndex.get(turn.items.length) ?? []));
  return merged;
}

function collectUpstreamRequestIds(
  turns: readonly PaginatedTurnMessages[],
): Set<string> {
  const requestIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      for (const message of item.messages) {
        const requestId = upstreamRequestId(message);
        if (requestId) requestIds.add(requestId);
      }
    }
  }
  return requestIds;
}

function sourceItemId(
  entryId: string | undefined,
  turnId: string,
): string | null {
  const prefix = `turn:${turnId}:item:`;
  if (!entryId?.startsWith(prefix)) return null;
  return entryId.slice(prefix.length) || null;
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
