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
import type { AgentName } from "../agents/session-types.js";
import type { AgentNativeSessionRef } from '@garcon/server-agent-interface';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createLogger } from '../lib/log.js';
import type { ChatProjectPathUpdatedPayload } from '../../common/ws-events.js';

const logger = createLogger('chats:store');

const CHAT_REGISTRY_VERSION = 3;
// Uses a fixed short debounce so registry mutations persist promptly while bursts coalesce.
const REGISTRY_SAVE_DEBOUNCE_MS = 1000;
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
] as const;

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
}

export type ChatRegistryPatch = Partial<Pick<ChatRegistryEntry, (typeof ALLOWED_PATCH_FIELDS)[number]>>;
export type ChatRegistryResolvedEntry = { id: string } & ChatRegistryEntry;
export interface ChatRegistryUpdateOptions {
  flush?: boolean;
}
export type ChatAddedCallback = (chatId: string) => void;
export type ChatRemovedCallback = (chatId: string) => void;
export type ChatReadUpdatedCallback = (chatId: string, lastReadAt: string | null | undefined) => void;
export type ChatProjectPathUpdatedCallback = (payload: ChatProjectPathUpdatedPayload) => void;
export interface ChatRegistryProjectPathUpdate extends ChatProjectPathUpdatedPayload {
  nativeSession?: AgentNativeSessionRef | null;
}
export type ResolveNativeSession = (
  session: ChatRegistryEntry,
  chatId: string,
) => Promise<AgentNativeSessionRef | null>;

export interface IChatRegistry {
  init(): Promise<ChatRegistrySnapshot>;
  getRegistry(): ChatRegistrySnapshot;
  reconcileSessions(resolveNativeSession: ResolveNativeSession): Promise<boolean>;
  listAllChats(): Record<string, ChatRegistryEntry>;
  getChat(id: string): ChatRegistryEntry | null;
  addChat(entry: NewChatRegistryEntry): boolean;
  updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry | null;
  updateChat(id: string, patch: ChatRegistryPatch, options: ChatRegistryUpdateOptions & { flush: true }): Promise<ChatRegistryResolvedEntry | null>;
  updateProjectPath(
    id: string,
    update: ChatRegistryProjectPathUpdate,
    options: { flush: true },
  ): Promise<ChatRegistryResolvedEntry | null>;
  removeChat(id: string): boolean;
  getChatByAgentSessionId(agentSessionId: string | null | undefined): [string, ChatRegistryEntry] | null;
  saveRegistry(registry: ChatRegistrySnapshot): Promise<void>;
  flush(): Promise<void>;
  onChatAdded(cb: ChatAddedCallback): void;
  onChatRemoved(cb: ChatRemovedCallback): void;
  onChatReadUpdated(cb: ChatReadUpdatedCallback): void;
  onChatProjectPathUpdated(cb: ChatProjectPathUpdatedCallback): void;
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

function normalizeChatRegistryEntry(rawEntry: Record<string, unknown>): ChatRegistryEntry {
  const agentId = normalizeAgentId(rawEntry);
  const nativeSession = normalizeNativeSession(rawEntry.nativeSession, agentId);
  const agentSettingsById = parseAgentSettingsById(rawEntry.agentSettingsById);
  if (!agentSettingsById) throw new Error(`Invalid agentSettingsById for ${agentId || 'unknown agent'}`);
  return {
    agentId,
    agentSessionId: normalizeNullableString(rawEntry.agentSessionId),
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
    nextForkOrdinal: normalizeNextForkOrdinal(rawEntry.nextForkOrdinal),
    ...normalizeRegistryModes(rawEntry),
  };
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

export class ChatRegistry extends EventEmitter implements IChatRegistry {
  #registry: ChatRegistrySnapshot | null = null;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #agentSessionIdIndex = new Map<string, string>();
  #workspaceDir: string;

  constructor(workspaceDir: string) {
    super();
    this.#workspaceDir = workspaceDir;
  }

  #emitChatAdded(id: string): void { this.emit('chat-added', id); }
  onChatAdded(cb: ChatAddedCallback): void { this.on('chat-added', cb); }

  #emitChatRemoved(id: string): void { this.emit('chat-removed', id); }
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

  #sessionsFilePath(): string {
    return path.join(this.#workspaceDir, 'chats.json');
  }

  async init(): Promise<ChatRegistrySnapshot> {
    if (this.#registry) return this.#registry;
    try {
      const raw = await fs.readFile(this.#sessionsFilePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isObjectRecord(parsed)) {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      if (!isObjectRecord(parsed.sessions)) {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      if (parsed.version !== CHAT_REGISTRY_VERSION) {
        throw new Error(`Unsupported chat registry version: ${String(parsed.version)}`);
      }
      const sessions: Record<string, ChatRegistryEntry> = {};
      for (const [rawChatId, rawEntry] of Object.entries(parsed.sessions)) {
        const chatId = parseChatId(rawChatId);
        if (!isObjectRecord(rawEntry)) {
          throw new Error(`Invalid chat registry entry for ${chatId}`);
        }
        sessions[chatId] = normalizeChatRegistryEntry(rawEntry);
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

  getRegistry(): ChatRegistrySnapshot {
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

      session.nativeSession = resolved;
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

  // Returns a shallow copy of all sessions.
  listAllChats(): Record<string, ChatRegistryEntry> {
    const registry = this.getRegistry();
    return Object.assign({}, registry.sessions);
  }

  getChat(id: string): ChatRegistryEntry | null {
    const registry = this.getRegistry();
    return registry.sessions[id] || null;
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
    registry.sessions[chatId] = {
      agentId,
      nativeSession,
      agentOwnershipEpoch,
      agentSettingsById,
      projectPath,
      tags,
      agentSessionId,
      nextForkOrdinal: normalizeNextForkOrdinal(nextForkOrdinal) ?? 1,
      model,
      apiProviderId,
      modelEndpointId,
      modelProtocol,
      ...normalizedModes,
    };
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
    const normalizedPatch: ChatRegistryPatch = { ...patch };
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
    const previousAgentSessionId = existing.agentSessionId;
    for (const key of ALLOWED_PATCH_FIELDS) {
      if (key in normalizedPatch) {
        existing[key] = normalizedPatch[key] as never;
      }
    }
    if ('agentSessionId' in normalizedPatch && existing.agentSessionId !== previousAgentSessionId) {
      this.#unsetAgentSessionIdIndex(id, previousAgentSessionId);
      this.#setAgentSessionIdIndex(id, existing.agentSessionId);
    }
    if ('lastReadAt' in normalizedPatch) {
      this.#emitChatReadUpdated(id, normalizedPatch.lastReadAt);
    }
    const resolved = { id, ...existing };
    if (options.flush) {
      return this.#flushRegistrySave().then(() => resolved);
    }
    this.#scheduleRegistrySave();
    return resolved;
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
    existing.projectPath = update.projectPath;
    if ('nativeSession' in update) {
      if (update.nativeSession?.ownerId !== existing.agentId && update.nativeSession !== null) {
        throw new Error(`Native session owner mismatch for ${id}`);
      }
      existing.nativeSession = update.nativeSession ?? null;
    }
    await this.#flushRegistrySave();
    this.#emitChatProjectPathUpdated({
      chatId: update.chatId,
      projectPath: update.projectPath,
      effectiveProjectKey: update.effectiveProjectKey,
      previousProjectPath: update.previousProjectPath,
      previousEffectiveProjectKey: update.previousEffectiveProjectKey,
    });
    return { id, ...existing };
  }

  removeChat(id: string): boolean {
    const registry = this.getRegistry();
    const entry = registry.sessions[id];
    if (!entry) return false;
    this.#unsetAgentSessionIdIndex(id, entry.agentSessionId);
    delete registry.sessions[id];
    this.#emitChatRemoved(id);
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

  async saveRegistry(registry: ChatRegistrySnapshot): Promise<void> {
    const target = this.#sessionsFilePath();
    await writeJsonFileAtomic(target, registry);
    this.#registry = registry;
    this.#rebuildAgentSessionIdIndex();
  }

  // Flushes any pending registry save immediately. Called during shutdown.
  async flush(): Promise<void> {
    await this.#flushRegistrySave();
  }

  async #flushRegistrySave(): Promise<void> {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    await this.saveRegistry(this.#registry || createEmptyRegistry());
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
    }, REGISTRY_SAVE_DEBOUNCE_MS);
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
