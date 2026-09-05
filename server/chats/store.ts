// Chat registry. Manages a single chats.json file that maps
// chat IDs to agent-specific session metadata.

import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'events';
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
import { parseChatId } from '../../common/chat-id.js';
import {
  parseParentChatRef,
  type ParentChatRef,
} from '../../common/chat-parentage.js';
import type { AgentName } from "../agents/session-types.js";
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { errorMessage } from '../lib/errors.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import type { ChatProjectPathUpdatedPayload } from '../../common/ws-events.js';
import { normalizeTags } from '../../common/tags.js';
import {
  parseNativeSeedReceipt,
  type NativeSeedReceipt,
} from '../../common/transcript-seed.js';
import { isCarryOverSegmentId } from './carryover-segment-types.js';

const logger = createLogger('chats:store');

export const CHAT_REGISTRY_VERSION = 5;
// Uses a fixed short debounce so registry mutations persist promptly while bursts coalesce.
const REGISTRY_SAVE_DEBOUNCE_MS = 1000;

interface ChatRegistryOptions {
  saveDelayMs?: number;
}
const ALLOWED_PATCH_FIELDS = [
  'agentId',
  'nativeSession',
  'agentOwnershipEpoch',
  'agentSettingsById',
  'tags',
  'agentSessionId',
  'nextForkOrdinal',
  'model',
  'apiProviderId',
  'modelEndpointId',
  'modelProtocol',
  'lastReadAt',
  'permissionMode',
  'thinkingMode',
  'carryOverSegments',
  'nativeSeedReceipt',
  'carryOverMigrationQuarantine',
] as const;

export interface CarryOverMigrationQuarantine {
  artifactId: string;
  errorCode: string;
}

export interface CarryOverHandoffTarget {
  readonly agentId: AgentName;
  readonly model: string;
}

export interface CarryOverSegmentRef {
  readonly id: string;
  readonly agentId: AgentName;
  readonly model: string;
  readonly capturedAt: string;
  readonly storedMessageCount: number;
  readonly visibleMessageCount: number;
  readonly trailingHandoff: CarryOverHandoffTarget | null;
}

export interface ChatRegistryEntry {
  agentId: AgentName;
  nativeSession: AgentNativeSessionRef | null;
  agentOwnershipEpoch: string;
  agentSettingsById: Record<string, AgentSettingsEnvelope>;
  projectPath: string;
  tags: string[];
  agentSessionId: string | null;
  nextForkOrdinal?: number;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  lastReadAt?: string | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  carryOverSegments: readonly CarryOverSegmentRef[];
  nativeSeedReceipt: NativeSeedReceipt | null;
  carryOverMigrationQuarantine: CarryOverMigrationQuarantine | null;
  readonly parentChat: ParentChatRef | null;
}

export interface ChatRegistrySnapshot {
  version: number;
  sessions: Record<string, ChatRegistryEntry>;
}

export interface NewChatRegistryEntry {
  id: string;
  agentId: AgentName;
  model: string;
  projectPath: string;
  nativeSession?: AgentNativeSessionRef | null;
  agentOwnershipEpoch?: string;
  agentSettingsById?: Record<string, AgentSettingsEnvelope>;
  tags?: string[];
  agentSessionId?: string | null;
  nextForkOrdinal?: number;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  carryOverSegments?: readonly CarryOverSegmentRef[];
  nativeSeedReceipt?: NativeSeedReceipt | null;
  carryOverMigrationQuarantine?: CarryOverMigrationQuarantine | null;
  parentChat: ParentChatRef | null;
}

export type ChatRegistryPatch = Partial<Pick<ChatRegistryEntry, (typeof ALLOWED_PATCH_FIELDS)[number]>>;
export type ChatRegistryResolvedEntry = { id: string } & ChatRegistryEntry;

function pickAllowedPatch(patch: ChatRegistryPatch): ChatRegistryPatch {
  return Object.fromEntries(
    ALLOWED_PATCH_FIELDS
      .filter((field) => Object.hasOwn(patch, field))
      .map((field) => [field, patch[field]]),
  );
}
export interface ChatRegistryUpdateOptions {
  flush?: boolean;
}
export type ChatRemovalReason = 'user-deletion' | 'start-compensation';
export type ChatAddedCallback = (chatId: string) => void;
export type ChatRemovedCallback = (chatId: string, reason: ChatRemovalReason) => void;
export type ChatReadUpdatedCallback = (chatId: string, lastReadAt: string | null | undefined) => void;
export type ChatProjectPathUpdatedCallback = (payload: ChatProjectPathUpdatedPayload) => void;
export type ChatTagsUpdatedCallback = (chatId: string) => void;

interface ChatRegistryEvents {
  'chat-added': Parameters<ChatAddedCallback>;
  'chat-removed': Parameters<ChatRemovedCallback>;
  'chat-read-updated': Parameters<ChatReadUpdatedCallback>;
  'chat-project-path-updated': Parameters<ChatProjectPathUpdatedCallback>;
  'chat-tags-updated': Parameters<ChatTagsUpdatedCallback>;
}

export interface ChatRegistryProjectPathUpdate extends ChatProjectPathUpdatedPayload {
  nativeSession?: AgentNativeSessionRef | null;
}
export type ResolveNativeSession = (
  session: ChatRegistryEntry,
  chatId: string,
) => Promise<AgentNativeSessionRef | null>;

export interface IChatRegistry {
  init(): Promise<ChatRegistrySnapshot>;
  reconcileSessions(resolveNativeSession: ResolveNativeSession): Promise<boolean>;
  listAllChats(): Record<string, ChatRegistryEntry>;
  // Ids are unique by construction (object keys).
  listChatIds(): string[];
  hasChat(id: string): boolean;
  getChat(id: string): ChatRegistryEntry | null;
  addChat(entry: NewChatRegistryEntry): boolean;
  updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry | null;
  updateChat(id: string, patch: ChatRegistryPatch, options: ChatRegistryUpdateOptions & { flush: true }): Promise<ChatRegistryResolvedEntry | null>;
  updateProjectPath(
    id: string,
    update: ChatRegistryProjectPathUpdate,
    options: { flush: true },
  ): Promise<ChatRegistryResolvedEntry | null>;
  addTags(id: string, tags: readonly string[]): ChatRegistryResolvedEntry | null;
  removeChat(id: string, reason?: ChatRemovalReason): boolean;
  getChatByAgentSessionId(agentSessionId: string | null | undefined): [string, ChatRegistryEntry] | null;
  saveRegistry(registry: ChatRegistrySnapshot): Promise<void>;
  flush(): Promise<void>;
  onChatAdded(cb: ChatAddedCallback): void;
  onChatRemoved(cb: ChatRemovedCallback): void;
  onChatReadUpdated(cb: ChatReadUpdatedCallback): void;
  onChatProjectPathUpdated(cb: ChatProjectPathUpdatedCallback): void;
  onChatTagsUpdated(cb: ChatTagsUpdatedCallback): void;
}

function createEmptyRegistry(): ChatRegistrySnapshot {
  return { version: CHAT_REGISTRY_VERSION, sessions: {} };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRegistryModes(entry: {
  permissionMode?: unknown;
  thinkingMode?: unknown;
}): Pick<ChatRegistryEntry, 'permissionMode' | 'thinkingMode'> {
  return {
    permissionMode: normalizePermissionMode(entry.permissionMode),
    thinkingMode: normalizeThinkingMode(entry.thinkingMode),
  };
}

function normalizeNextForkOrdinal(value: unknown): number | undefined {
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

function normalizeAgentId(rawEntry: Record<string, unknown>): AgentName {
  const value = rawEntry.agentId;
  return typeof value === 'string' ? value as AgentName : '';
}

function normalizeChatRegistryEntry(
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
  assertSeedReceiptBinding({ agentSessionId, nativeSeedReceipt });
  return {
    agentId,
    agentSessionId,
    nativeSession,
    agentOwnershipEpoch: normalizeOwnershipEpoch(rawEntry.agentOwnershipEpoch),
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
    parentChat: readParentChat(rawEntry.parentChat, chatId),
  };
}

function readParentChat(value: unknown, chatId: string): ParentChatRef | null {
  if (value === undefined || value === null) return null;
  const parsed = parseParentChatRef(value);
  if (!parsed) logger.warn(`sessions: ignoring invalid parentChat for ${chatId}`);
  return parsed;
}

function requireNewParentChat(value: unknown, chatId: string): ParentChatRef | null {
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

function parseCarryOverHandoffTarget(value: unknown): CarryOverHandoffTarget | null {
  if (value === null) return null;
  if (!isObjectRecord(value)) throw new Error('Invalid carryover handoff target');
  return Object.freeze({
    agentId: normalizeAgentName(value.agentId, 'handoff target agent'),
    model: requiredString(value.model, 'handoff target model'),
  });
}

function normalizeNativeSeedReceipt(value: unknown): NativeSeedReceipt | null {
  if (value === null) return null;
  const receipt = parseNativeSeedReceipt(value);
  if (!receipt) throw new Error('Invalid native seed receipt');
  return receipt;
}

function normalizeMigrationQuarantine(value: unknown): CarryOverMigrationQuarantine | null {
  if (value === null) return null;
  if (!isObjectRecord(value)) throw new Error('Invalid carryover migration quarantine');
  const artifactId = normalizeString(value.artifactId);
  const errorCode = normalizeString(value.errorCode);
  if (!artifactId || !errorCode) throw new Error('Invalid carryover migration quarantine');
  return { artifactId, errorCode };
}

function assertSeedReceiptBinding(entry: Pick<
  ChatRegistryEntry,
  'agentSessionId' | 'nativeSeedReceipt'
>): void {
  const receipt = entry.nativeSeedReceipt;
  if (!receipt) return;
  if (receipt.agentSessionId !== entry.agentSessionId) {
    throw new Error('Native seed receipt session mismatch');
  }
}

function normalizeAgentName(value: unknown, field: string): AgentName {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid carryover ${field}`);
  return value as AgentName;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid carryover ${field}`);
  return value;
}

function requiredTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid carryover ${field}`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid carryover ${field}`);
  }
  return Number(value);
}

function normalizeOwnershipEpoch(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Chat is missing agentOwnershipEpoch');
  return value;
}

function normalizeNativeSession(value: unknown, agentId: string): AgentNativeSessionRef | null {
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

export class ChatRegistry extends EventEmitter<ChatRegistryEvents> implements IChatRegistry {
  #registry: ChatRegistrySnapshot | null = null;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #registryWriteLock = new KeyedPromiseLock();
  #chatMutationRevisions = new Map<string, number>();
  #nextChatMutationRevision = 0;
  #agentSessionIdIndex = new Map<string, string>();
  #workspaceDir: string;
  #saveDelayMs: number;

  constructor(workspaceDir: string, options: ChatRegistryOptions = {}) {
    super();
    this.#workspaceDir = workspaceDir;
    this.#saveDelayMs = options.saveDelayMs ?? REGISTRY_SAVE_DEBOUNCE_MS;
  }

  #emitChatAdded(id: string): void { this.emit('chat-added', id); }
  onChatAdded(cb: ChatAddedCallback): void { this.on('chat-added', cb); }

  #emitChatRemoved(id: string, reason: ChatRemovalReason): void {
    this.emit('chat-removed', id, reason);
  }
  onChatRemoved(cb: ChatRemovedCallback): void { this.on('chat-removed', cb); }

  #emitChatReadUpdated(id: string, lastReadAt: string | null | undefined): void {
    this.emit('chat-read-updated', id, lastReadAt);
  }
  onChatReadUpdated(cb: ChatReadUpdatedCallback): void { this.on('chat-read-updated', cb); }

  #emitChatProjectPathUpdated(payload: ChatProjectPathUpdatedPayload): void {
    this.emit('chat-project-path-updated', payload);
  }
  onChatProjectPathUpdated(cb: ChatProjectPathUpdatedCallback): void {
    this.on('chat-project-path-updated', cb);
  }
  #emitChatTagsUpdated(id: string): void { this.emit('chat-tags-updated', id); }
  onChatTagsUpdated(cb: ChatTagsUpdatedCallback): void { this.on('chat-tags-updated', cb); }

  #sessionsFilePath(): string {
    return path.join(this.#workspaceDir, 'chats.json');
  }

  async init(): Promise<ChatRegistrySnapshot> {
    if (this.#registry) return this.#registry;
    try {
      const sessionsFilePath = this.#sessionsFilePath();
      const raw = await fs.readFile(sessionsFilePath, 'utf8');
      if (process.platform !== 'win32') {
        await fs.chmod(sessionsFilePath, 0o600).catch((error) => {
          logger.warn('sessions: failed to repair chats.json permissions:', errorMessage(error));
        });
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isObjectRecord(parsed)) {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      if (parsed.version !== CHAT_REGISTRY_VERSION) {
        throw new Error(`Unsupported chat registry version: ${String(parsed.version)}`);
      }
      if (!isObjectRecord(parsed.sessions)) {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      const sessions: Record<string, ChatRegistryEntry> = {};
      for (const [rawChatId, rawEntry] of Object.entries(parsed.sessions)) {
        const chatId = parseChatId(rawChatId);
        if (!isObjectRecord(rawEntry)) {
          throw new Error(`Invalid chat registry entry for ${chatId}`);
        }
        sessions[chatId] = normalizeChatRegistryEntry(rawEntry, chatId);
      }
      this.#registry = {
        version: CHAT_REGISTRY_VERSION,
        sessions,
      };
      this.#rebuildAgentSessionIdIndex();
      return this.#registry;
    } catch (error: unknown) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        this.#registry = createEmptyRegistry();
        this.#rebuildAgentSessionIdIndex();
        return this.#registry;
      }
      throw error;
    }
  }

  // Hands out the live snapshot; private because it bypasses the clone-on-
  // hand-out protection every public accessor upholds.
  private getRegistry(): ChatRegistrySnapshot {
    if (!this.#registry) {
      throw new Error('Registry cache not initialized. Call init() during startup.');
    }
    return this.#registry;
  }

  async reconcileSessions(resolveNativeSession: ResolveNativeSession): Promise<boolean> {
    const registry = this.getRegistry();
    const sessions = registry.sessions;
    let dirty = false;

    for (const [chatId, session] of Object.entries(sessions)) {
      if (!session?.agentSessionId) {
        logger.warn(`sessions: preserving chat ${chatId} with missing agentSessionId`);
        continue;
      }

      let resolved: AgentNativeSessionRef | null;
      try {
        resolved = await resolveNativeSession(session, chatId);
      } catch (error) {
        logger.warn(`sessions: native session reconciliation failed for ${chatId}:`, (error as Error).message);
        continue;
      }
      if (!resolved) {
        logger.warn(`sessions: preserving chat ${chatId} with unresolved native session`);
        continue;
      }
      if (resolved.ownerId !== session.agentId) {
        throw new Error(`Native session owner mismatch for ${chatId}`);
      }
      if (isDeepStrictEqual(resolved, session.nativeSession)) continue;

      // Resolver-supplied refs are plugin-owned; clone on ingest so the
      // plugin cannot mutate registry state through the object it returned.
      session.nativeSession = structuredClone(resolved);
      this.#advanceChatMutationRevision(chatId);
      dirty = true;
    }

    if (!dirty) return false;

    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    await this.saveRegistry(registry);
    return true;
  }

  listAllChats(): Record<string, ChatRegistryEntry> {
    const registry = this.getRegistry();
    return Object.fromEntries(
      Object.entries(registry.sessions).map(([id, entry]) => [id, cloneRegistryEntry(entry)]),
    );
  }

  // Ids-only read for callers that never touch entry data; avoids the
  // per-entry cloning cost of listAllChats on hot paths. Ids are unique
  // by construction (object keys).
  listChatIds(): string[] {
    return Object.keys(this.getRegistry().sessions);
  }

  // Existence check that skips the per-entry clone getChat pays. Own-keys
  // only: sessions is a plain object, so a bare lookup would report
  // Object.prototype names like "toString" as existing chats.
  hasChat(id: string): boolean {
    return Object.hasOwn(this.getRegistry().sessions, id);
  }

  getChat(id: string): ChatRegistryEntry | null {
    const registry = this.getRegistry();
    const entry = registry.sessions[id];
    return entry ? cloneRegistryEntry(entry) : null;
  }

  addChat({
    id,
    agentId,
    model,
    projectPath,
    nativeSession = null,
    agentOwnershipEpoch = crypto.randomUUID(),
    agentSettingsById = {},
    tags = [],
    agentSessionId = null,
    nextForkOrdinal = 1,
    apiProviderId = null,
    modelEndpointId = null,
    modelProtocol = null,
    permissionMode = 'default',
    thinkingMode = 'none',
    carryOverSegments = [],
    nativeSeedReceipt = null,
    carryOverMigrationQuarantine = null,
    parentChat,
  }: NewChatRegistryEntry): boolean {
    const chatId = parseChatId(id);
    if (!agentId) throw new Error('Agent not specified');
    if (!model) throw new Error('Model not specified');
    if (!projectPath) throw new Error('Project path not specified');
    const registry = this.getRegistry();
    if (chatId in registry.sessions) {
      throw new Error(`Chat with ID ${chatId} already exists`);
    }
    if (nativeSession?.ownerId !== agentId && nativeSession !== null) {
      throw new Error(`Native session owner mismatch for ${chatId}`);
    }
    const normalizedModes = normalizeRegistryModes({ permissionMode, thinkingMode });
    const normalizedSegments = parseCarryOverSegmentRefs(carryOverSegments);
    const normalizedReceipt = normalizeNativeSeedReceipt(nativeSeedReceipt);
    const normalizedQuarantine = normalizeMigrationQuarantine(carryOverMigrationQuarantine);
    const normalizedParentChat = requireNewParentChat(parentChat, chatId);
    assertSeedReceiptBinding({
      agentSessionId,
      nativeSeedReceipt: normalizedReceipt,
    });
    registry.sessions[chatId] = {
      agentId,
      nativeSession: nativeSession ? structuredClone(nativeSession) : null,
      agentOwnershipEpoch,
      agentSettingsById: structuredClone(agentSettingsById),
      projectPath,
      tags: [...tags],
      agentSessionId,
      nextForkOrdinal: normalizeNextForkOrdinal(nextForkOrdinal) ?? 1,
      model,
      apiProviderId,
      modelEndpointId,
      modelProtocol,
      ...normalizedModes,
      carryOverSegments: normalizedSegments,
      nativeSeedReceipt: normalizedReceipt,
      carryOverMigrationQuarantine: normalizedQuarantine,
      parentChat: normalizedParentChat,
    };
    this.#advanceChatMutationRevision(chatId);
    this.#setAgentSessionIdIndex(chatId, agentSessionId);
    this.#emitChatAdded(chatId);
    this.#scheduleRegistrySave();
    return true;
  }

  updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry | null;
  updateChat(id: string, patch: ChatRegistryPatch, options: ChatRegistryUpdateOptions & { flush: true }): Promise<ChatRegistryResolvedEntry | null>;
  updateChat(
    id: string,
    patch: ChatRegistryPatch,
    options: ChatRegistryUpdateOptions = {},
  ): ChatRegistryResolvedEntry | null | Promise<ChatRegistryResolvedEntry | null> {
    const registry = this.getRegistry();
    const existing = registry.sessions[id];
    if (!existing) return options.flush ? Promise.resolve(null) : null;
    const normalizedPatch = pickAllowedPatch(patch);
    if ('permissionMode' in normalizedPatch) {
      normalizedPatch.permissionMode = normalizePermissionMode(normalizedPatch.permissionMode);
    }
    if ('thinkingMode' in normalizedPatch) {
      normalizedPatch.thinkingMode = normalizeThinkingMode(normalizedPatch.thinkingMode);
    }
    if ('nextForkOrdinal' in normalizedPatch) {
      normalizedPatch.nextForkOrdinal = normalizeNextForkOrdinal(normalizedPatch.nextForkOrdinal);
    }
    if ('nativeSession' in normalizedPatch && normalizedPatch.nativeSession?.ownerId !== (normalizedPatch.agentId ?? existing.agentId)) {
      if (normalizedPatch.nativeSession !== null) throw new Error(`Native session owner mismatch for ${id}`);
    }
    if ('agentSettingsById' in normalizedPatch && !parseAgentSettingsById(normalizedPatch.agentSettingsById)) {
      throw new Error(`Invalid agent settings for ${id}`);
    }
    // Caller-owned collections are cloned before entering the registry so
    // later caller mutations cannot alias registry state.
    if (normalizedPatch.agentSettingsById) {
      normalizedPatch.agentSettingsById = structuredClone(normalizedPatch.agentSettingsById);
    }
    if (normalizedPatch.tags) {
      normalizedPatch.tags = [...normalizedPatch.tags];
    }
    if (normalizedPatch.nativeSession) {
      normalizedPatch.nativeSession = structuredClone(normalizedPatch.nativeSession);
    }
    if ('carryOverSegments' in normalizedPatch) {
      normalizedPatch.carryOverSegments = parseCarryOverSegmentRefs(normalizedPatch.carryOverSegments);
    }
    if ('nativeSeedReceipt' in normalizedPatch) {
      normalizedPatch.nativeSeedReceipt = normalizeNativeSeedReceipt(normalizedPatch.nativeSeedReceipt);
    }
    if ('carryOverMigrationQuarantine' in normalizedPatch) {
      normalizedPatch.carryOverMigrationQuarantine = normalizeMigrationQuarantine(
        normalizedPatch.carryOverMigrationQuarantine,
      );
    }
    const candidate = { ...existing, ...normalizedPatch };
    assertSeedReceiptBinding(candidate);
    const previous = { ...existing };
    const previousAgentSessionId = existing.agentSessionId;
    const previousTags = existing.tags;
    Object.assign(existing, normalizedPatch);
    const mutationRevision = this.#advanceChatMutationRevision(id);
    if ('agentSessionId' in normalizedPatch && existing.agentSessionId !== previousAgentSessionId) {
      this.#unsetAgentSessionIdIndex(id, previousAgentSessionId);
      this.#setAgentSessionIdIndex(id, existing.agentSessionId);
    }
    const emitUpdateEvents = (): void => {
      if ('lastReadAt' in normalizedPatch) {
        this.#emitChatReadUpdated(id, normalizedPatch.lastReadAt);
      }
      if ('tags' in normalizedPatch && !isDeepStrictEqual(existing.tags, previousTags)) {
        this.#emitChatTagsUpdated(id);
      }
    };
    const resolved = { id, ...cloneRegistryEntry(existing) };
    if (options.flush) {
      const restoreIfCurrent = (): void => {
        if (this.#chatMutationRevisions.get(id) !== mutationRevision) return;
        registry.sessions[id] = previous;
        this.#advanceChatMutationRevision(id);
        this.#rebuildAgentSessionIdIndex();
        this.#scheduleRegistrySave();
      };
      return this.#flushRegistrySave(restoreIfCurrent).then(
        () => {
          emitUpdateEvents();
          return resolved;
        },
        (error: unknown) => {
          restoreIfCurrent();
          throw error;
        },
      );
    }
    emitUpdateEvents();
    this.#scheduleRegistrySave();
    return resolved;
  }

  addTags(id: string, tags: readonly string[]): ChatRegistryResolvedEntry | null {
    const existing = this.getRegistry().sessions[id];
    if (!existing) return null;
    const nextTags = normalizeTags([...existing.tags, ...tags]);
    if (isDeepStrictEqual(nextTags, existing.tags)) return { id, ...existing };
    existing.tags = nextTags;
    this.#advanceChatMutationRevision(id);
    this.#emitChatTagsUpdated(id);
    this.#scheduleRegistrySave();
    return { id, ...existing };
  }

  async updateProjectPath(
    id: string,
    update: ChatRegistryProjectPathUpdate,
    _options: { flush: true },
  ): Promise<ChatRegistryResolvedEntry | null> {
    const registry = this.getRegistry();
    const existing = registry.sessions[id];
    if (!existing) return null;
    if (update.chatId !== id) {
      throw new Error(`Project path update identity mismatch: ${id}`);
    }
    const previousProjectPath = existing.projectPath;
    const previousNativeSession = existing.nativeSession;
    existing.projectPath = update.projectPath;
    if ('nativeSession' in update) {
      if (update.nativeSession?.ownerId !== existing.agentId && update.nativeSession !== null) {
        throw new Error(`Native session owner mismatch for ${id}`);
      }
      // Update-supplied refs stay reachable to the caller (the command layer
      // retains one for its published session fact); clone on ingest to match
      // addChat/updateChat aliasing protection.
      existing.nativeSession = update.nativeSession
        ? structuredClone(update.nativeSession)
        : null;
    }
    const mutationRevision = this.#advanceChatMutationRevision(id);
    const restoreIfCurrent = (): void => {
      if (this.#chatMutationRevisions.get(id) !== mutationRevision) return;
      existing.projectPath = previousProjectPath;
      existing.nativeSession = previousNativeSession;
      this.#advanceChatMutationRevision(id);
      this.#scheduleRegistrySave();
    };
    try {
      await this.#flushRegistrySave(restoreIfCurrent);
    } catch (error) {
      restoreIfCurrent();
      throw error;
    }
    this.#emitChatProjectPathUpdated({
      chatId: update.chatId,
      projectPath: update.projectPath,
      effectiveProjectKey: update.effectiveProjectKey,
      previousProjectPath: update.previousProjectPath,
      previousEffectiveProjectKey: update.previousEffectiveProjectKey,
    });
    return { id, ...existing };
  }

  removeChat(id: string, reason: ChatRemovalReason = 'user-deletion'): boolean {
    const registry = this.getRegistry();
    const entry = registry.sessions[id];
    if (!entry) return false;
    this.#unsetAgentSessionIdIndex(id, entry.agentSessionId);
    delete registry.sessions[id];
    this.#chatMutationRevisions.delete(id);
    this.#emitChatRemoved(id, reason);
    this.#scheduleRegistrySave();
    return true;
  }

  getChatByAgentSessionId(agentSessionId: string | null | undefined): [string, ChatRegistryEntry] | null {
    const registry = this.#registry;
    if (!registry) {
      throw new Error('Registry cache not initialized. Call init() during startup.');
    }
    if (!agentSessionId) return null;
    const chatId = this.#agentSessionIdIndex.get(agentSessionId);
    if (!chatId) return null;
    const entry = registry.sessions[chatId];
    if (!entry || entry.agentSessionId !== agentSessionId) {
      this.#agentSessionIdIndex.delete(agentSessionId);
      return null;
    }
    return [chatId, entry];
  }

  async saveRegistry(
    registry: ChatRegistrySnapshot,
    onWriteFailure?: () => void,
  ): Promise<void> {
    const target = this.#sessionsFilePath();
    await this.#registryWriteLock.runExclusive(
      target,
      async () => {
        try {
          await writeJsonFileAtomic(target, registry, { mode: 0o600 });
        } catch (error) {
          onWriteFailure?.();
          throw error;
        }
      },
    );
    this.#registry = registry;
    this.#rebuildAgentSessionIdIndex();
  }

  // Flushes any pending registry save immediately. Called during shutdown.
  async flush(): Promise<void> {
    await this.#flushRegistrySave();
  }

  async #flushRegistrySave(onWriteFailure?: () => void): Promise<void> {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    await this.saveRegistry(
      this.#registry || createEmptyRegistry(),
      onWriteFailure,
    );
  }

  #scheduleRegistrySave(): void {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    this.#pendingSaveTimer = setTimeout(() => {
      this.#pendingSaveTimer = null;
      this.saveRegistry(this.#registry || createEmptyRegistry()).catch((error: Error) => {
        logger.warn('sessions: failed to persist registry:', error.message);
      });
    }, this.#saveDelayMs);
  }

  #advanceChatMutationRevision(id: string): number {
    const revision = ++this.#nextChatMutationRevision;
    this.#chatMutationRevisions.set(id, revision);
    return revision;
  }

  #rebuildAgentSessionIdIndex(): void {
    this.#agentSessionIdIndex.clear();
    const sessions = this.#registry?.sessions;
    if (!sessions) return;
    for (const [chatId, entry] of Object.entries(sessions)) {
      this.#setAgentSessionIdIndex(chatId, entry.agentSessionId);
    }
  }

  #setAgentSessionIdIndex(chatId: string, agentSessionId: string | null | undefined): void {
    if (!agentSessionId) return;
    if (!this.#agentSessionIdIndex.has(agentSessionId)) {
      this.#agentSessionIdIndex.set(agentSessionId, chatId);
    }
  }

  #unsetAgentSessionIdIndex(chatId: string, agentSessionId: string | null | undefined): void {
    if (!agentSessionId) return;
    if (this.#agentSessionIdIndex.get(agentSessionId) === chatId) {
      this.#agentSessionIdIndex.delete(agentSessionId);
      for (const [candidateChatId, entry] of Object.entries(this.#registry?.sessions ?? {})) {
        if (candidateChatId !== chatId && entry.agentSessionId === agentSessionId) {
          this.#agentSessionIdIndex.set(agentSessionId, candidateChatId);
          break;
        }
      }
    }
  }
}

function cloneRegistryEntry(entry: ChatRegistryEntry): ChatRegistryEntry {
  return {
    ...entry,
    // Frozen fields (parentChat, carryOverSegments) are safe to share; copy the mutable ones
    // so callers cannot mutate registry state through a handed-out entry.
    agentSettingsById: structuredClone(entry.agentSettingsById),
    tags: [...entry.tags],
    nativeSession: entry.nativeSession ? structuredClone(entry.nativeSession) : null,
    nativeSeedReceipt: entry.nativeSeedReceipt ? { ...entry.nativeSeedReceipt } : null,
    carryOverMigrationQuarantine: entry.carryOverMigrationQuarantine
      ? { ...entry.carryOverMigrationQuarantine }
      : null,
  };
}
