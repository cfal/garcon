import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../../common/chat-types.js';
import { AgentSwitchMessage, parseChatMessages } from '../../common/chat-types.js';
import { parseNativeSeedReceipt } from '../../common/transcript-seed.js';
import { isRecord } from '../../common/json.js';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import {
  emptyOwnershipJournalV5,
  type AgentOwnershipJournalFileV5,
  type DeleteIntentV2,
} from './agent-ownership-journal.js';
import type { CarryOverTranscriptStore } from './carryover-transcript-store.js';
import { decodeCarryOverPage } from './carryover-page-codec.js';
import {
  parseCarryOverNode,
  type CarryOverNode,
  type MaterializedCarryOverNode,
} from './legacy-carryover-node-types.js';
import type { CarryOverSegmentRef } from './store.js';

export interface LegacyCarryOverSegment {
  readonly agentId: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly at: string;
  readonly boundary: boolean;
  readonly boundaryTarget: { readonly agentId: string; readonly model: string } | null;
}

export class LegacyCarryOverDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LegacyCarryOverDataError';
  }
}

const VERIFICATION_BATCH_SIZE = 256;

// Compares the committed segments against the transcript the migration expected
// to render without materializing a second copy of either side, which keeps peak
// memory proportional to one batch rather than to the largest chat.
export async function migratedTranscriptMatches(
  store: CarryOverTranscriptStore,
  refs: readonly CarryOverSegmentRef[],
  expected: readonly ChatMessage[],
): Promise<boolean> {
  let index = 0;
  for await (const batch of store.stream({
    refs,
    maxMessagesPerBatch: VERIFICATION_BATCH_SIZE,
  })) {
    for (const message of batch) {
      if (index >= expected.length) return false;
      if (JSON.stringify(message) !== JSON.stringify(expected[index])) return false;
      index += 1;
    }
  }
  return index === expected.length;
}

export function parseLegacyCarryOverFile(bytes: Buffer): Map<string, unknown> {
  if (bytes.byteLength === 0) return new Map();
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.chats)) throw new Error('Invalid legacy carryover file');
  return new Map(Object.entries(parsed.chats));
}

export function activeLegacySegments(
  value: unknown,
  registryEntry: Readonly<Record<string, unknown>>,
): LegacyCarryOverSegment[] {
  if (value === undefined) return [];
  let rawSegments: unknown;
  if (Array.isArray(value)) rawSegments = value;
  else if (isRecord(value)) {
    const staged = isRecord(value.staged) ? value.staged : null;
    const stagedCommitted = staged
      && staged.ownerId === registryEntry.agentId
      && staged.targetEpoch === registryEntry.agentOwnershipEpoch;
    rawSegments = stagedCommitted ? staged.segments : value.segments;
  } else {
    throw new LegacyCarryOverDataError('Invalid legacy carryover chat entry');
  }
  if (!Array.isArray(rawSegments)) {
    throw new LegacyCarryOverDataError('Invalid legacy carryover segment list');
  }
  return rawSegments.map((raw, index) => parseLegacySegment(raw, index));
}

export async function convertLinkedHistory(input: {
  readonly workspaceDir: string;
  readonly chatId: string;
  readonly entry: Readonly<Record<string, unknown>>;
  readonly headId: string | null;
  readonly store: CarryOverTranscriptStore;
}): Promise<{ refs: readonly CarryOverSegmentRef[]; segmentIds: readonly string[] }> {
  if (!input.headId) return { refs: [], segmentIds: [] };
  const chain = await loadLinkedChain(input.workspaceDir, input.headId);
  const current = {
    agentId: legacyRequiredString(input.entry.agentId, `agent for ${input.chatId}`),
    model: legacyStringValue(input.entry.model, `model for ${input.chatId}`),
  };
  const refs: CarryOverSegmentRef[] = [];
  const segmentIds = new Set<string>();
  const materializedMessages = new Map<string, readonly ChatMessage[]>();
  const logical: ChatMessage[] = [];
  for (const [index, node] of chain.entries()) {
    const materialized = node.kind === 'materialized'
      ? node
      : await readLinkedMaterialized(input.workspaceDir, node.sourceNodeId, node.parentId);
    const messages = await readLinkedMessages(input.workspaceDir, materialized, materializedMessages);
    const visibleMessageCount = node.kind === 'prefix' ? node.messageCount : materialized.messageCount;
    if (visibleMessageCount > materialized.messageCount) {
      throw new LegacyCarryOverDataError(`Linked carryover cutoff is invalid for ${input.chatId}`);
    }
    if (materialized.messageCount > 0) {
      const prepared = await input.store.prepareSegment({
        operationId: `migration:v4:${materialized.id}`,
        id: materialized.id,
        seedSanitation: materialized.seedSanitation,
        messages,
      });
      await prepared.commit();
      prepared.releaseRoot();
      segmentIds.add(materialized.id);
    }
    const next = chain[index + 1];
    const nextSource = next?.source ?? current;
    const trailingHandoff = node.kind === 'materialized' && node.boundary
      ? { agentId: nextSource.agentId, model: nextSource.model }
      : null;
    refs.push({
      id: materialized.id,
      agentId: node.source.agentId,
      model: node.source.model,
      capturedAt: materialized.createdAt,
      storedMessageCount: materialized.messageCount,
      visibleMessageCount,
      trailingHandoff,
    });
    logical.push(...messages.slice(0, visibleMessageCount));
    if (trailingHandoff) {
      logical.push(new AgentSwitchMessage(
        materialized.createdAt,
        node.source.agentId,
        trailingHandoff.agentId,
        node.source.model,
        trailingHandoff.model,
      ));
    }
  }
  await input.store.assertAvailable(refs);
  if (!await migratedTranscriptMatches(input.store, refs, logical)) {
    throw new LegacyCarryOverDataError(
      `Migrated linked carryover transcript differs for chat ${input.chatId}`,
    );
  }
  return { refs, segmentIds: [...segmentIds] };
}

export function migrateV4Receipt(value: unknown, expectedHeadId: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value.headId !== expectedHeadId) {
    throw new LegacyCarryOverDataError('Linked carryover receipt is not bound to its history head');
  }
  const parsed = parseNativeSeedReceipt(value);
  if (!parsed) throw new LegacyCarryOverDataError('Invalid linked carryover seed receipt');
  return parsed;
}

export async function migrateLegacyOwnershipJournal(input: {
  readonly workspaceDir: string;
  readonly bytes: Buffer;
  readonly sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly sourceRegistryVersion: 3 | 4;
  readonly store: CarryOverTranscriptStore;
}): Promise<AgentOwnershipJournalFileV5> {
  if (input.bytes.byteLength === 0) return emptyOwnershipJournalV5();
  const value: unknown = JSON.parse(input.bytes.toString('utf8'));
  if (!isRecord(value)) throw new Error('Invalid legacy ownership journal');
  if (value.version === 5) return value as unknown as AgentOwnershipJournalFileV5;
  if (value.version === 4 || value.version === 3 || value.version === 2) {
    return migrateJournalIntents(value);
  }
  if (value.version !== 1 || !Array.isArray(value.intents)) {
    throw new Error('Unsupported legacy ownership journal');
  }
  const ownershipIntents: DeleteIntentV2[] = [];
  for (const raw of value.intents) {
    if (!isRecord(raw) || !isRecord(raw.oldReference) || typeof raw.chatId !== 'string') {
      throw new Error('Invalid legacy ownership intent');
    }
    const current = input.sessions[raw.chatId];
    if (raw.kind === 'transfer') {
      if (current
          && current.agentId !== raw.targetAgentId
          && !matchesLegacySource(current, raw)) {
        throw new Error(`Legacy transfer ownership mismatch for ${raw.chatId}`);
      }
    } else if (raw.kind === 'delete') {
      if (!current) {
        const source = {
          ...raw.oldReference,
          nativeSeedReceipt: null,
          agentOwnershipEpoch: typeof raw.oldEpoch === 'string'
            ? raw.oldEpoch
            : `legacy-release:${raw.chatId}`,
        };
        ownershipIntents.push({
          version: 2,
          operationId: requiredString(raw.id, 'legacy delete ID'),
          kind: 'delete',
          chatId: raw.chatId,
          phase: 'registry-removed',
          sourceEpoch: typeof raw.oldEpoch === 'string' ? raw.oldEpoch : null,
          releaseReferences: [source as unknown as AgentChatReference],
          createdAt: requiredString(raw.createdAt, 'legacy delete timestamp'),
        });
      } else if (!matchesLegacySource(current, raw)) {
        throw new Error(`Legacy delete ownership mismatch for ${raw.chatId}`);
      }
    } else {
      throw new Error('Invalid legacy ownership intent kind');
    }
  }
  return { version: 5, ownershipIntents };
}

function migrateJournalIntents(
  value: Readonly<Record<string, unknown>>,
): AgentOwnershipJournalFileV5 {
  if (!Array.isArray(value.ownershipIntents)) throw new Error('Invalid ownership journal');
  const ownershipIntents: DeleteIntentV2[] = [];
  for (const raw of value.ownershipIntents) {
    if (!isRecord(raw)) throw new Error('Invalid ownership intent');
    if (raw.kind === 'delete') ownershipIntents.push(raw as unknown as DeleteIntentV2);
    else if (raw.kind !== 'handoff') throw new Error('Invalid ownership intent kind');
  }
  return { version: 5, ownershipIntents };
}

function parseLegacySegment(value: unknown, index: number): LegacyCarryOverSegment {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new LegacyCarryOverDataError(`Invalid legacy carryover segment ${index}`);
  }
  let messages: ChatMessage[];
  try {
    messages = parseChatMessages(value.messages);
  } catch (error) {
    throw new LegacyCarryOverDataError(`Invalid legacy carryover message in segment ${index}`, {
      cause: error,
    });
  }
  if (messages.length !== value.messages.length) {
    throw new LegacyCarryOverDataError(`Invalid legacy carryover message in segment ${index}`);
  }
  const boundaryTarget = isRecord(value.boundaryTarget)
    ? {
        agentId: legacyRequiredString(value.boundaryTarget.agentId, 'boundary agent'),
        model: legacyStringValue(value.boundaryTarget.model, 'boundary model'),
      }
    : null;
  const at = typeof value.at === 'string' && Number.isFinite(Date.parse(value.at))
    ? value.at
    : new Date(0).toISOString();
  return {
    agentId: legacyRequiredString(value.agentId, 'segment agent'),
    model: legacyStringValue(value.model, 'segment model'),
    messages,
    at,
    boundary: value.boundary !== false,
    boundaryTarget,
  };
}

async function loadLinkedChain(
  workspaceDir: string,
  headId: string,
): Promise<readonly CarryOverNode[]> {
  const reversed: CarryOverNode[] = [];
  const visited = new Set<string>();
  let cursor: string | null = headId;
  while (cursor) {
    if (visited.has(cursor)) throw new LegacyCarryOverDataError('Linked carryover history contains a cycle');
    visited.add(cursor);
    const node = await readLinkedNode(workspaceDir, cursor);
    reversed.push(node);
    cursor = node.parentId;
  }
  return reversed.reverse();
}

async function readLinkedNode(workspaceDir: string, id: string): Promise<CarryOverNode> {
  try {
    const raw = await fs.readFile(
      path.join(workspaceDir, 'carryover-transcripts', 'nodes', id, 'manifest.json'),
      'utf8',
    );
    return parseCarryOverNode(JSON.parse(raw), id);
  } catch (error) {
    if (isFileSystemError(error)) throw error;
    throw new LegacyCarryOverDataError(`Invalid linked carryover node ${id}`, { cause: error });
  }
}

async function readLinkedMaterialized(
  workspaceDir: string,
  id: string,
  expectedParentId: string | null,
): Promise<MaterializedCarryOverNode> {
  const node = await readLinkedNode(workspaceDir, id);
  if (node.kind !== 'materialized') {
    throw new LegacyCarryOverDataError(`Linked carryover prefix source ${id} is not materialized`);
  }
  // The v4 runtime refused a prefix whose source sat on a different parent, and
  // dropping that check here would silently import a hybrid chain: the
  // transcript self-check cannot catch it, because it is assembled from the same
  // wrongly resolved source.
  if (node.parentId !== expectedParentId) {
    throw new LegacyCarryOverDataError(
      `Linked carryover prefix source ${id} does not share its prefix parent`,
    );
  }
  return node;
}

async function readLinkedMessages(
  workspaceDir: string,
  node: MaterializedCarryOverNode,
  cache: Map<string, readonly ChatMessage[]>,
): Promise<readonly ChatMessage[]> {
  const cached = cache.get(node.id);
  if (cached) return cached;
  const messages: ChatMessage[] = [];
  try {
    for (const page of node.pages) {
      messages.push(...await decodeCarryOverPage(
        path.join(workspaceDir, 'carryover-transcripts', 'nodes', node.id, page.file),
        page,
      ));
    }
  } catch (error) {
    if (isFileSystemError(error)) throw error;
    throw new LegacyCarryOverDataError(`Invalid linked carryover pages for ${node.id}`, { cause: error });
  }
  if (messages.length !== node.messageCount) {
    throw new LegacyCarryOverDataError(`Linked carryover message count differs for ${node.id}`);
  }
  cache.set(node.id, messages);
  return messages;
}

function matchesLegacySource(
  current: Readonly<Record<string, unknown>> | undefined,
  intent: Readonly<Record<string, unknown>>,
): boolean {
  if (!current) return false;
  const reference = intent.oldReference as Record<string, unknown>;
  return current.agentId === reference.agentId
    && current.agentOwnershipEpoch === intent.oldEpoch
    && current.agentSessionId === reference.agentSessionId
    && JSON.stringify(current.nativeSession) === JSON.stringify(reference.nativeSession);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${field}`);
  return value;
}

function legacyRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new LegacyCarryOverDataError(`Invalid ${field}`);
  return value;
}

function legacyStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new LegacyCarryOverDataError(`Invalid ${field}`);
  return value;
}

function isFileSystemError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof error.code === 'string'
    && /^E[A-Z]+/.test(error.code),
  );
}
