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
import {
  assertPreambleBoundaryBinding,
  assertSeedReceiptBinding,
  createEmptyRegistry,
  isObjectRecord,
  normalizeChatRegistryEntry,
  normalizeMigrationQuarantine,
  normalizeNativeSeedReceipt,
  normalizeNextForkOrdinal,
  normalizePreambleSelection,
  normalizeRegistryModes,
  parseCarryOverSegmentRefs,
  parsePendingPreambleBoundary,
  requireNewParentChat,
} from './registry-entry-codec.js';
import { writeJsonFileAtomic, AtomicJsonWriteError } from '../lib/json-file-store.js';
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
import {
  normalizeChatPreambleSelection,
  normalizePendingPreambleBoundary,
  type ChatPreambleSelection,
  type PendingPreambleBoundary,
} from '../../common/preambles.js';

const logger = createLogger('chats:store');

export const CHAT_REGISTRY_VERSION = 5;

export { parseCarryOverSegmentRefs } from './registry-entry-codec.js';
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
  'pendingPreambleBoundary',
  'preambleSelection',
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
  pendingPreambleBoundary: PendingPreambleBoundary | null;
  // Required normalized per-chat preamble selection; chats.json is authoritative.
  preambleSelection: ChatPreambleSelection;
  readonly parentChat: ParentChatRef | null;
}

export interface ChatRegistrySnapshot {
  version: number;
  sessions: Record<string, ChatRegistryEntry>;
}

export interface PhasedChatUpdateResult {
  readonly entry: ChatRegistryResolvedEntry;
  readonly durability: 'durable' | 'unknown';
}

// Raised when a phased update is attempted for a chat whose previous registry
// write committed but never confirmed its directory durability.
export class ChatRegistryDurabilityUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatRegistryDurabilityUnknownError';
  }
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
  pendingPreambleBoundary?: PendingPreambleBoundary | null;
  // Every creation path writes an explicit already-resolved selection; there is
  // no persisted "inherit defaults" mode.
  preambleSelection: ChatPreambleSelection;
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
  updateChatPhased(id: string, patch: ChatRegistryPatch): Promise<PhasedChatUpdateResult | null>;
  reconcileUnknownDurability(id: string): Promise<'confirmed' | 'unavailable' | 'still-unknown'>;
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



export class ChatRegistry extends EventEmitter<ChatRegistryEvents> implements IChatRegistry {
  #registry: ChatRegistrySnapshot | null = null;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #registryWriteLock = new KeyedPromiseLock();
  #chatMutationRevisions = new Map<string, number>();
  #nextChatMutationRevision = 0;
  #agentSessionIdIndex = new Map<string, string>();
  #unknownDurabilityChats = new Set<string>();
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
    // Own-keys only, matching hasChat: a bare lookup hands back
    // Object.prototype for names like "toString" and the clone throws.
    const entry = Object.hasOwn(registry.sessions, id) ? registry.sessions[id] : null;
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
    pendingPreambleBoundary = null,
    preambleSelection,
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
    const normalizedPreambleBoundary = parsePendingPreambleBoundary(pendingPreambleBoundary);
    const normalizedPreambleSelection = normalizePreambleSelection(preambleSelection);
    assertPreambleBoundaryBinding({
      agentOwnershipEpoch,
      pendingPreambleBoundary: normalizedPreambleBoundary,
      preambleSelection: normalizedPreambleSelection,
    });
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
      pendingPreambleBoundary: normalizedPreambleBoundary,
      preambleSelection: {
        revision: normalizedPreambleSelection.revision,
        orderedPreambleIds: [...normalizedPreambleSelection.orderedPreambleIds],
      },
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
    const normalizedPatch = this.#normalizeChatPatch(id, existing, patch);
    const candidate = { ...existing, ...normalizedPatch };
    // Ordinary updates prove the complete boundary binding, matching
    // initialization and phased updates: a selection-change boundary must
    // match both the ownership epoch and the selection revision.
    assertPreambleBoundaryBinding(candidate);
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

  #normalizeChatPatch(
    id: string,
    existing: ChatRegistryEntry,
    patch: ChatRegistryPatch,
  ): ChatRegistryPatch {
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
    if ('pendingPreambleBoundary' in normalizedPatch) {
      normalizedPatch.pendingPreambleBoundary = parsePendingPreambleBoundary(
        normalizedPatch.pendingPreambleBoundary,
      );
    }
    if ('preambleSelection' in normalizedPatch) {
      const selection = normalizePreambleSelection(normalizedPatch.preambleSelection);
      normalizedPatch.preambleSelection = {
        revision: selection.revision,
        orderedPreambleIds: [...selection.orderedPreambleIds],
      };
    }
    return normalizedPatch;
  }

  // Keeps the phased candidate private until its write either commits or reaches
  // an unknown post-rename outcome. Generic writers therefore cannot serialize a
  // candidate that later fails before rename.
  async updateChatPhased(
    id: string,
    patch: ChatRegistryPatch,
  ): Promise<PhasedChatUpdateResult | null> {
    const target = this.#sessionsFilePath();
    return this.#registryWriteLock.runExclusive(target, async () => {
      const registry = this.getRegistry();
      const existing = registry.sessions[id];
      if (!existing) return null;
      if (this.#unknownDurabilityChats.has(id)) {
        throw new ChatRegistryDurabilityUnknownError(
          `The chat registry has an unconfirmed save for ${id}; reload before further changes.`,
        );
      }
      const normalizedPatch = this.#normalizeChatPatch(id, existing, patch);
      const candidateEntry = { ...existing, ...normalizedPatch };
      assertPreambleBoundaryBinding(candidateEntry);
      assertSeedReceiptBinding(candidateEntry);
      const candidateRegistry = cloneRegistrySnapshot(registry);
      candidateRegistry.sessions[id] = cloneRegistryEntry(candidateEntry);
      let durability: 'durable' | 'unknown' = 'durable';
      try {
        await writeJsonFileAtomic(target, candidateRegistry, { mode: 0o600 });
        this.#unknownDurabilityChats.clear();
      } catch (error) {
        if (error instanceof AtomicJsonWriteError && error.renamed) {
          this.#unknownDurabilityChats.add(id);
          durability = 'unknown';
        } else {
          throw error;
        }
      }

      const current = this.getRegistry().sessions[id];
      if (!current) return null;
      const previousAgentSessionId = current.agentSessionId;
      const previousTags = current.tags;
      Object.assign(current, normalizedPatch);
      assertPreambleBoundaryBinding(current);
      assertSeedReceiptBinding(current);
      this.#advanceChatMutationRevision(id);
      if ('agentSessionId' in normalizedPatch
        && current.agentSessionId !== previousAgentSessionId) {
        this.#unsetAgentSessionIdIndex(id, previousAgentSessionId);
        this.#setAgentSessionIdIndex(id, current.agentSessionId);
      }
      if ('lastReadAt' in normalizedPatch) {
        this.#emitChatReadUpdated(id, normalizedPatch.lastReadAt);
      }
      if ('tags' in normalizedPatch && !isDeepStrictEqual(current.tags, previousTags)) {
        this.#emitChatTagsUpdated(id);
      }
      return {
        entry: { id, ...cloneRegistryEntry(current) },
        durability,
      };
    });
  }

  addTags(id: string, tags: readonly string[]): ChatRegistryResolvedEntry | null {
    const existing = this.getRegistry().sessions[id];
    if (!existing) return null;
    const nextTags = normalizeTags([...existing.tags, ...tags]);
    if (isDeepStrictEqual(nextTags, existing.tags)) {
      return { id, ...cloneRegistryEntry(existing) };
    }
    existing.tags = nextTags;
    this.#advanceChatMutationRevision(id);
    this.#emitChatTagsUpdated(id);
    this.#scheduleRegistrySave();
    return { id, ...cloneRegistryEntry(existing) };
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
    return { id, ...cloneRegistryEntry(existing) };
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
    return [chatId, cloneRegistryEntry(entry)];
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
    // A confirmed flush proves every previously unknown-durability candidate.
    this.#unknownDurabilityChats.clear();
  }

  // Flushes any pending registry save immediately. Called during shutdown.
  // Client-accessible reconciliation for a durability-unknown phased commit:
  // rewriting the current in-memory registry proves the file is writable and,
  // on success, clears the mutation fence for that chat.
  async reconcileUnknownDurability(
    id: string,
  ): Promise<'confirmed' | 'unavailable' | 'still-unknown'> {
    const registry = this.getRegistry();
    if (!registry.sessions[id]) return 'unavailable';
    if (!this.#unknownDurabilityChats.has(id)) return 'confirmed';
    try {
      await this.#flushRegistrySave();
      return this.#unknownDurabilityChats.has(id) ? 'still-unknown' : 'confirmed';
    } catch {
      return 'still-unknown';
    }
  }

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
    // Deeply frozen fields (parentChat, carryOverSegments) are safe to share; every
    // other nested field must be copied here so callers cannot mutate registry
    // state through a handed-out entry. New entry fields declare themselves by
    // landing in one of these two groups.
    agentSettingsById: structuredClone(entry.agentSettingsById),
    tags: [...entry.tags],
    nativeSession: entry.nativeSession ? structuredClone(entry.nativeSession) : null,
    nativeSeedReceipt: entry.nativeSeedReceipt ? { ...entry.nativeSeedReceipt } : null,
    pendingPreambleBoundary: entry.pendingPreambleBoundary
      ? { ...entry.pendingPreambleBoundary }
      : null,
    preambleSelection: {
      revision: entry.preambleSelection.revision,
      orderedPreambleIds: [...entry.preambleSelection.orderedPreambleIds],
    },
    carryOverMigrationQuarantine: entry.carryOverMigrationQuarantine
      ? { ...entry.carryOverMigrationQuarantine }
      : null,
  };
}

function cloneRegistrySnapshot(registry: ChatRegistrySnapshot): ChatRegistrySnapshot {
  return {
    version: registry.version,
    sessions: Object.fromEntries(
      Object.entries(registry.sessions).map(([id, entry]) => [id, cloneRegistryEntry(entry)]),
    ),
  };
}
