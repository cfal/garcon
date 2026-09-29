import type { ChatMessage } from '@garcon/common/chat-types';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import {
  attachNativeMessageSource,
  getNativeMessageSource,
} from '@garcon/server-agent-common/shared/native-message-source';
import type { CodexHistoryProfile } from '../history-profile.js';
import { CodexAppServerClient } from './client.js';
import { convertCodexAppServerItem } from './converter.js';
import { loadPaginatedUserMessageEvidence } from './paginated-user-message-evidence.js';
import type { ThreadItemEntry } from './protocol.js';

const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 100_000;

type PaginatedProfile = Extract<CodexHistoryProfile, { mode: 'paginated' }>;

interface PaginatedTurnShell {
  readonly turnId: string;
  readonly timestamp: string;
  readonly ordinal: number;
}

interface PaginatedProviderItem {
  readonly turnId: string;
  readonly itemId: string;
  readonly messages: ChatMessage[];
}

interface ProviderItemPosition {
  readonly itemId: string;
  readonly globalIndex: number;
  readonly turnIndex: number;
}

export interface CodexPaginatedHistoryClient {
  listThreadTurns: CodexAppServerClient['listThreadTurns'];
  listThreadItems: CodexAppServerClient['listThreadItems'];
  shutdown(): void | Promise<void>;
}

export class PaginatedCodexHistorySource {
  constructor(
    private readonly profile: PaginatedProfile,
    private readonly createClient: () => CodexPaginatedHistoryClient,
    private readonly loadUserMessageEvidence = loadPaginatedUserMessageEvidence,
    private readonly maxPageCount = MAX_HISTORY_PAGES,
  ) {}

  async load(signal: AbortSignal): Promise<ChatMessage[]> {
    signal.throwIfAborted();
    const steps = new EventLoopSteps('codex-paginated-history');
    const client = this.createClient();
    try {
      // Items load before turn shells: a turn always exists before its items,
      // so a turn appended between the scans only leaves an empty trailing
      // shell. The reverse order would orphan that turn's items and fail the
      // whole load against an actively growing thread.
      const itemEntries = await this.#loadItemEntries(client, signal);
      const turnShells = await this.#loadTurnShells(client, signal, steps);
      const turnById = new Map(turnShells.map((turn) => [turn.turnId, turn]));
      const providerItems = await convertProviderItems(itemEntries, turnById, steps);
      const evidence = await this.loadUserMessageEvidence(
        this.profile.nativePath,
        this.profile.createdAt,
        signal,
        new Set(turnById.keys()),
      );
      signal.throwIfAborted();
      return await mergeEvidence(
        turnShells,
        providerItems,
        evidence.messages,
        evidence.orderedItemIdsByTurn,
        steps,
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

  async #loadTurnShells(
    client: CodexPaginatedHistoryClient,
    signal: AbortSignal,
    steps: EventLoopSteps,
  ): Promise<PaginatedTurnShell[]> {
    const turns = await collectHistoryPages(
      'turn',
      signal,
      this.maxPageCount,
      (cursor) => client.listThreadTurns({
        threadId: this.profile.threadId,
        cursor,
        limit: HISTORY_PAGE_SIZE,
        sortDirection: 'asc',
        itemsView: 'notLoaded',
      }),
    );
    const seenTurnIds = new Set<string>();
    const shells: PaginatedTurnShell[] = [];
    await steps.forEach(turns, (turn) => {
      if (turn.itemsView !== 'notLoaded') {
        throw new Error(`Codex returned ${turn.itemsView} items for turn ${turn.id}`);
      }
      if (seenTurnIds.has(turn.id)) throw new Error(`Codex repeated history turn ${turn.id}`);
      seenTurnIds.add(turn.id);
      shells.push({
        turnId: turn.id,
        timestamp: codexTimestamp(
          turn.startedAt ?? turn.completedAt,
          this.profile.createdAt,
        ),
        ordinal: shells.length,
      });
    });
    return shells;
  }

  #loadItemEntries(
    client: CodexPaginatedHistoryClient,
    signal: AbortSignal,
  ): Promise<ThreadItemEntry[]> {
    return collectHistoryPages(
      'item',
      signal,
      this.maxPageCount,
      (cursor) => client.listThreadItems({
        threadId: this.profile.threadId,
        turnId: null,
        cursor,
        limit: HISTORY_PAGE_SIZE,
        sortDirection: 'asc',
      }),
    );
  }
}

async function collectHistoryPages<T>(
  kind: 'turn' | 'item',
  signal: AbortSignal,
  maxPageCount: number,
  listPage: (cursor: string | null) => Promise<{
    readonly data: T[];
    readonly nextCursor: string | null;
  }>,
): Promise<T[]> {
  const entries: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    signal.throwIfAborted();
    const response = await listPage(cursor);
    signal.throwIfAborted();
    entries.push(...response.data);
    cursor = response.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`Codex repeated history ${kind} cursor ${cursor}`);
    }
    if (cursor) seenCursors.add(cursor);
    pageCount += 1;
    if (cursor && pageCount >= maxPageCount) {
      throw new Error(`Codex paginated ${kind} history exceeded the page limit`);
    }
  } while (cursor);
  return entries;
}

async function convertProviderItems(
  entries: readonly ThreadItemEntry[],
  turnById: ReadonlyMap<string, PaginatedTurnShell>,
  steps: EventLoopSteps,
): Promise<PaginatedProviderItem[]> {
  const seenItems = new Set<string>();
  const items: PaginatedProviderItem[] = [];
  await steps.forEach(entries, ({ turnId, item }) => {
    const turn = turnById.get(turnId);
    if (!turn) throw new Error(`Codex item ${item.id} refers to unknown turn ${turnId}`);
    const itemKey = providerItemKey(turnId, item.id);
    if (seenItems.has(itemKey)) throw new Error(`Codex repeated history item ${item.id}`);
    seenItems.add(itemKey);
    const converted = convertCodexAppServerItem(item, turn.timestamp, {
      includeUserMessages: true,
    });
    items.push({
      turnId,
      itemId: item.id,
      messages: converted.map((message, withinSourceOrdinal) => (
        attachNativeMessageSource(message, {
          entryId: `turn:${turnId}:item:${item.id}`,
          withinSourceOrdinal,
        })
      )),
    });
  });
  return items;
}

async function mergeEvidence(
  turnShells: readonly PaginatedTurnShell[],
  providerItems: readonly PaginatedProviderItem[],
  evidenceMessages: readonly ChatMessage[],
  orderedItemIdsByTurn: ReadonlyMap<string, readonly string[]>,
  steps: EventLoopSteps,
): Promise<ChatMessage[]> {
  const providerPositionsByTurn = await collectProviderPositions(providerItems, steps);
  const claimedRequestIds = await collectUpstreamRequestIds(providerItems, steps);
  const evidenceByItem = await collectUnrepresentedEvidence(
    evidenceMessages,
    providerItems,
    claimedRequestIds,
    steps,
  );
  const insertions = new Map<number, ChatMessage[]>();

  await steps.forEach(turnShells, (turn) => {
    const orderedEvidenceIds = orderedItemIdsByTurn.get(turn.turnId) ?? [];
    const positions = providerPositionsByTurn.get(turn.turnId) ?? [];
    validateEvidenceOrder(turn.turnId, orderedEvidenceIds, positions);
    const missingIds = orderedEvidenceIds.filter((itemId) => (
      evidenceByItem.has(providerItemKey(turn.turnId, itemId))
    ));
    if (missingIds.length === 0) return;

    if (positions.length === 0) {
      appendInsertion(
        insertions,
        emptyTurnInsertionIndex(turn, turnShells, providerItems),
        missingIds.flatMap((itemId) => (
          evidenceByItem.get(providerItemKey(turn.turnId, itemId)) ?? []
        )),
      );
      return;
    }

    const evidenceIndexes = new Map(
      orderedEvidenceIds.map((itemId, index) => [itemId, index]),
    );
    const anchors = positions.flatMap((position) => {
      const evidenceIndex = evidenceIndexes.get(position.itemId);
      return evidenceIndex === undefined ? [] : [{ ...position, evidenceIndex }];
    }).sort((left, right) => left.evidenceIndex - right.evidenceIndex);
    if (anchors.length === 0) {
      throw new Error(`Codex item evidence has no provider anchor for turn ${turn.turnId}`);
    }

    for (const itemId of missingIds) {
      const evidenceIndex = evidenceIndexes.get(itemId);
      if (evidenceIndex === undefined) continue;
      const previous = anchors.findLast((anchor) => anchor.evidenceIndex < evidenceIndex);
      const next = anchors.find((anchor) => anchor.evidenceIndex > evidenceIndex);
      const providerGapStart = (previous?.turnIndex ?? -1) + 1;
      const providerGapEnd = next?.turnIndex ?? positions.length;
      if (providerGapStart !== providerGapEnd) {
        throw new Error(`Codex item evidence has an ambiguous position for turn ${turn.turnId}`);
      }
      const insertionIndex = next?.globalIndex
        ?? (positions.at(-1)?.globalIndex ?? providerItems.length - 1) + 1;
      appendInsertion(
        insertions,
        insertionIndex,
        evidenceByItem.get(providerItemKey(turn.turnId, itemId)) ?? [],
      );
    }
  });

  const merged: ChatMessage[] = [];
  await steps.forEach(providerItems.entries(), ([index, item]) => {
    merged.push(...(insertions.get(index) ?? []), ...item.messages);
  });
  merged.push(...(insertions.get(providerItems.length) ?? []));
  return merged;
}

async function collectProviderPositions(
  items: readonly PaginatedProviderItem[],
  steps: EventLoopSteps,
): Promise<Map<string, ProviderItemPosition[]>> {
  const positions = new Map<string, ProviderItemPosition[]>();
  await steps.forEach(items.entries(), ([globalIndex, item]) => {
    const turnPositions = positions.get(item.turnId) ?? [];
    turnPositions.push({
      itemId: item.itemId,
      globalIndex,
      turnIndex: turnPositions.length,
    });
    positions.set(item.turnId, turnPositions);
  });
  return positions;
}

function validateEvidenceOrder(
  turnId: string,
  orderedEvidenceIds: readonly string[],
  positions: readonly ProviderItemPosition[],
): void {
  const providerIndexById = new Map(
    positions.map((position) => [position.itemId, position.turnIndex]),
  );
  let previousIndex = -1;
  for (const itemId of orderedEvidenceIds) {
    const providerIndex = providerIndexById.get(itemId);
    if (providerIndex === undefined) continue;
    if (providerIndex <= previousIndex) {
      throw new Error(`Codex item evidence conflicts with provider order for turn ${turnId}`);
    }
    previousIndex = providerIndex;
  }
}

async function collectUnrepresentedEvidence(
  messages: readonly ChatMessage[],
  providerItems: readonly PaginatedProviderItem[],
  claimedRequestIds: Set<string>,
  steps: EventLoopSteps,
): Promise<Map<string, ChatMessage[]>> {
  const providerKeys = new Set<string>();
  await steps.forEach(providerItems, (item) => {
    providerKeys.add(providerItemKey(item.turnId, item.itemId));
  });
  const evidenceByItem = new Map<string, ChatMessage[]>();
  await steps.forEach(messages, (message) => {
    const source = sourceItemIdentity(getNativeMessageSource(message)?.entryId);
    if (!source) return;
    const key = providerItemKey(source.turnId, source.itemId);
    if (providerKeys.has(key)) return;
    const requestId = upstreamRequestId(message);
    if (requestId && claimedRequestIds.has(requestId)) return;
    if (requestId) claimedRequestIds.add(requestId);
    const itemMessages = evidenceByItem.get(key) ?? [];
    itemMessages.push(message);
    evidenceByItem.set(key, itemMessages);
  });
  return evidenceByItem;
}

function emptyTurnInsertionIndex(
  turn: PaginatedTurnShell,
  turns: readonly PaginatedTurnShell[],
  providerItems: readonly PaginatedProviderItem[],
): number {
  const turnOrdinal = new Map(turns.map((candidate) => [candidate.turnId, candidate.ordinal]));
  let previousIndex = -1;
  let nextIndex = providerItems.length;
  providerItems.forEach((item, index) => {
    const ordinal = turnOrdinal.get(item.turnId);
    if (ordinal === undefined) return;
    if (ordinal < turn.ordinal) previousIndex = Math.max(previousIndex, index);
    if (ordinal > turn.ordinal) nextIndex = Math.min(nextIndex, index);
  });
  if (previousIndex >= nextIndex) {
    throw new Error(`Codex item evidence has an ambiguous position for turn ${turn.turnId}`);
  }
  return nextIndex;
}

function appendInsertion(
  insertions: Map<number, ChatMessage[]>,
  index: number,
  messages: readonly ChatMessage[],
): void {
  const positioned = insertions.get(index) ?? [];
  positioned.push(...messages);
  insertions.set(index, positioned);
}

async function collectUpstreamRequestIds(
  items: readonly PaginatedProviderItem[],
  steps: EventLoopSteps,
): Promise<Set<string>> {
  const requestIds = new Set<string>();
  await steps.forEach(items, (item) => {
    for (const message of item.messages) {
      const requestId = upstreamRequestId(message);
      if (requestId) requestIds.add(requestId);
    }
  });
  return requestIds;
}

function sourceItemIdentity(
  entryId: string | undefined,
): { turnId: string; itemId: string } | null {
  if (!entryId?.startsWith('turn:')) return null;
  const separator = entryId.indexOf(':item:', 'turn:'.length);
  if (separator < 0) return null;
  const turnId = entryId.slice('turn:'.length, separator);
  const itemId = entryId.slice(separator + ':item:'.length);
  return turnId && itemId ? { turnId, itemId } : null;
}

function providerItemKey(turnId: string, itemId: string): string {
  return `${turnId}\0${itemId}`;
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
