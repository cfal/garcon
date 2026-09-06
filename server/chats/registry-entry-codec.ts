import {
  normalizePermissionMode,
  normalizeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from '../../common/chat-modes.js';
import {
  parseAgentSettingsById,
  type AgentSettingsEnvelope,
} from '../../common/agent-integration.js';
import type { JsonObject, JsonValue } from '../../common/json.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import {
  parseParentChatRef,
  type ParentChatRef,
} from '../../common/chat-parentage.js';
import {
  normalizeChatPreambleSelection,
  normalizePendingPreambleBoundary,
  type ChatPreambleSelection,
  type PendingPreambleBoundary,
} from '../../common/preambles.js';
import {
  parseNativeSeedReceipt,
  type NativeSeedReceipt,
} from '../../common/transcript-seed.js';
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';
import type { AgentName } from '../agents/session-types.js';
import { createLogger } from '../lib/log.js';
import { isCarryOverSegmentId } from './carryover-segment-types.js';
import {
  CHAT_REGISTRY_VERSION,
  type CarryOverHandoffTarget,
  type CarryOverMigrationQuarantine,
  type CarryOverSegmentRef,
  type ChatRegistryEntry,
  type ChatRegistrySnapshot,
} from './store.js';

const logger = createLogger('chats:store');

export function createEmptyRegistry(): ChatRegistrySnapshot {
  return { version: CHAT_REGISTRY_VERSION, sessions: {} };
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeRegistryModes(entry: {
  permissionMode?: unknown;
  thinkingMode?: unknown;
}): Pick<ChatRegistryEntry, 'permissionMode' | 'thinkingMode'> {
  return {
    permissionMode: normalizePermissionMode(entry.permissionMode),
    thinkingMode: normalizeThinkingMode(entry.thinkingMode),
  };
}

export function normalizeNextForkOrdinal(value: unknown): number | undefined {
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number'
      ? value
      : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parsePendingPreambleBoundary(value: unknown): PendingPreambleBoundary | null {
  if (value === undefined || value === null) return null;
  const boundary = normalizePendingPreambleBoundary(value);
  if (!boundary) throw new Error('Invalid pending preamble boundary');
  return boundary;
}

// Only an absent field is the legacy default; an explicit null or malformed
// present value rejects the registry rather than meaning deselection.
export function normalizePreambleSelection(value: unknown): ChatPreambleSelection {
  if (value === undefined) {
    return { revision: 0, orderedPreambleIds: [] };
  }
  const selection = normalizeChatPreambleSelection(value);
  if (!selection) throw new Error('Invalid preamble selection');
  return selection;
}

export function assertPreambleBoundaryBinding(entry: {
  readonly agentOwnershipEpoch: string;
  readonly pendingPreambleBoundary: PendingPreambleBoundary | null;
  readonly preambleSelection: ChatPreambleSelection;
}): void {
  const boundary = entry.pendingPreambleBoundary;
  if (!boundary) return;
  if (boundary.ownershipEpoch !== entry.agentOwnershipEpoch) {
    throw new Error('Preamble boundary ownership epoch mismatch');
  }
  if (boundary.kind === 'selection-change'
    && boundary.selectionRevision !== entry.preambleSelection.revision) {
    throw new Error('Preamble boundary selection revision mismatch');
  }
}

export function normalizeAgentId(rawEntry: Record<string, unknown>): AgentName {
  const value = rawEntry.agentId;
  return typeof value === 'string' ? value as AgentName : '';
}

export function normalizeChatRegistryEntry(
  rawEntry: Record<string, unknown>,
  chatId: string,
): ChatRegistryEntry {
  const agentId = normalizeAgentId(rawEntry);
  const nativeSession = normalizeNativeSession(rawEntry.nativeSession, agentId);
  const agentSettingsById = parseAgentSettingsById(rawEntry.agentSettingsById);
  if (!agentSettingsById) throw new Error(`Invalid agentSettingsById for ${agentId || 'unknown agent'}`);
  const agentSessionId = normalizeNullableString(rawEntry.agentSessionId);
  const carryOverSegments = parseCarryOverSegmentRefs(rawEntry.carryOverSegments);
  const nativeSeedReceipt = normalizeNativeSeedReceipt(rawEntry.nativeSeedReceipt);
  const agentOwnershipEpoch = normalizeOwnershipEpoch(rawEntry.agentOwnershipEpoch);
  const pendingPreambleBoundary = parsePendingPreambleBoundary(rawEntry.pendingPreambleBoundary);
  const preambleSelection = normalizePreambleSelection(rawEntry.preambleSelection);
  assertPreambleBoundaryBinding({ agentOwnershipEpoch, pendingPreambleBoundary, preambleSelection });
  assertSeedReceiptBinding({ agentSessionId, nativeSeedReceipt });
  return {
    agentId,
    agentSessionId,
    nativeSession,
    agentOwnershipEpoch,
    agentSettingsById,
    projectPath: normalizeString(rawEntry.projectPath),
    tags: Array.isArray(rawEntry.tags) ? rawEntry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    model: normalizeString(rawEntry.model),
    apiProviderId: normalizeNullableString(rawEntry.apiProviderId),
    modelEndpointId: normalizeNullableString(rawEntry.modelEndpointId),
    modelProtocol: rawEntry.modelProtocol === 'openai-compatible' || rawEntry.modelProtocol === 'anthropic-messages'
      ? rawEntry.modelProtocol
      : null,
    lastReadAt: normalizeNullableString(rawEntry.lastReadAt),
    ...(() => {
      const nextForkOrdinal = normalizeNextForkOrdinal(rawEntry.nextForkOrdinal);
      return nextForkOrdinal === undefined ? {} : { nextForkOrdinal };
    })(),
    ...normalizeRegistryModes(rawEntry),
    carryOverSegments,
    nativeSeedReceipt,
    carryOverMigrationQuarantine: normalizeMigrationQuarantine(rawEntry.carryOverMigrationQuarantine),
    pendingPreambleBoundary,
    preambleSelection,
    parentChat: readParentChat(rawEntry.parentChat, chatId),
  };
}

export function readParentChat(value: unknown, chatId: string): ParentChatRef | null {
  if (value === undefined || value === null) return null;
  const parsed = parseParentChatRef(value);
  if (!parsed) logger.warn(`sessions: ignoring invalid parentChat for ${chatId}`);
  return parsed;
}

export function requireNewParentChat(value: unknown, chatId: string): ParentChatRef | null {
  if (value === null) return null;
  const parsed = parseParentChatRef(value);
  if (!parsed) throw new Error(`Invalid parent chat for ${chatId}`);
  if (parsed.chatId === chatId) throw new Error(`Chat ${chatId} cannot be its own parent`);
  return parsed;
}

export function parseCarryOverSegmentRefs(value: unknown): readonly CarryOverSegmentRef[] {
  if (!Array.isArray(value)) throw new Error('Invalid carryover segment references');
  const ids = new Set<string>();
  const refs = value.map((raw): CarryOverSegmentRef => {
    if (!isObjectRecord(raw)) throw new Error('Invalid carryover segment reference');
    if (!isCarryOverSegmentId(raw.id)) throw new Error('Invalid carryover segment ID');
    if (ids.has(raw.id)) throw new Error('Duplicate carryover segment ID');
    ids.add(raw.id);
    const agentId = normalizeAgentName(raw.agentId, 'segment agent');
    const model = requiredString(raw.model, 'segment model');
    const capturedAt = requiredTimestamp(raw.capturedAt, 'segment capture time');
    const storedMessageCount = nonNegativeSafeInteger(raw.storedMessageCount, 'stored message count');
    const visibleMessageCount = nonNegativeSafeInteger(raw.visibleMessageCount, 'visible message count');
    if (visibleMessageCount > storedMessageCount) {
      throw new Error('Carryover segment cutoff is outside its artifact');
    }
    const trailingHandoff = parseCarryOverHandoffTarget(raw.trailingHandoff);
    if (storedMessageCount === 0) {
      if (visibleMessageCount !== 0 || trailingHandoff === null) {
        throw new Error('Empty carryover segment must contain one handoff boundary');
      }
    } else if (visibleMessageCount === 0) {
      throw new Error('Non-empty carryover segment must expose at least one message');
    }
    return Object.freeze({
      id: raw.id,
      agentId,
      model,
      capturedAt,
      storedMessageCount,
      visibleMessageCount,
      trailingHandoff,
    });
  });
  return Object.freeze(refs);
}

export function parseCarryOverHandoffTarget(value: unknown): CarryOverHandoffTarget | null {
  if (value === null) return null;
  if (!isObjectRecord(value)) throw new Error('Invalid carryover handoff target');
  return Object.freeze({
    agentId: normalizeAgentName(value.agentId, 'handoff target agent'),
    model: requiredString(value.model, 'handoff target model'),
  });
}

export function normalizeNativeSeedReceipt(value: unknown): NativeSeedReceipt | null {
  if (value === null) return null;
  const receipt = parseNativeSeedReceipt(value);
  if (!receipt) throw new Error('Invalid native seed receipt');
  return receipt;
}

export function normalizeMigrationQuarantine(value: unknown): CarryOverMigrationQuarantine | null {
  if (value === null) return null;
  if (!isObjectRecord(value)) throw new Error('Invalid carryover migration quarantine');
  const artifactId = normalizeString(value.artifactId);
  const errorCode = normalizeString(value.errorCode);
  if (!artifactId || !errorCode) throw new Error('Invalid carryover migration quarantine');
  return { artifactId, errorCode };
}

export function assertSeedReceiptBinding(entry: Pick<
  ChatRegistryEntry,
  'agentSessionId' | 'nativeSeedReceipt'
>): void {
  const receipt = entry.nativeSeedReceipt;
  if (!receipt) return;
  if (receipt.agentSessionId !== entry.agentSessionId) {
    throw new Error('Native seed receipt session mismatch');
  }
}

export function normalizeAgentName(value: unknown, field: string): AgentName {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid carryover ${field}`);
  return value as AgentName;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid carryover ${field}`);
  return value;
}

export function requiredTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid carryover ${field}`);
  }
  return value;
}

export function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid carryover ${field}`);
  }
  return Number(value);
}

export function normalizeOwnershipEpoch(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Chat is missing agentOwnershipEpoch');
  return value;
}

export function normalizeNativeSession(value: unknown, agentId: string): AgentNativeSessionRef | null {
  if (value === null || value === undefined) return null;
  if (!isObjectRecord(value)) throw new Error(`Invalid native session for ${agentId}`);
  if (value.ownerId !== agentId) throw new Error(`Native session owner mismatch for ${agentId}`);
  if (!Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) {
    throw new Error(`Invalid native session schema version for ${agentId}`);
  }
  if (!isJsonObject(value.value)) throw new Error(`Invalid native session value for ${agentId}`);
  return {
    ownerId: agentId,
    schemaVersion: Number(value.schemaVersion),
    value: value.value,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return isObjectRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
