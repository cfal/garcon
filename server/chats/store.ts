// Chat registry. Manages a single chats.json file that maps
// chat IDs to agent-specific session metadata.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
  type AmpAgentMode,
  type ClaudeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from '../../common/chat-modes.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentName } from "../agents/session-types.js";
import { isArtificialNativePath } from './artificial-native-path.js';

const NATIVE_PATH_LRU_MAX = 64;
const ALLOWED_PATCH_FIELDS = [
  'agentId',
  'nativePath',
  'projectPath',
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
  'claudeThinkingMode',
  'ampAgentMode',
] as const;

export interface ChatRegistryEntry {
  agentId: AgentName;
  nativePath: string | null;
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
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
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
  nativePath?: string | null;
  tags?: string[];
  agentSessionId?: string | null;
  nextForkOrdinal?: number;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  ampAgentMode?: AmpAgentMode;
}

export type ChatRegistryPatch = Partial<Pick<ChatRegistryEntry, (typeof ALLOWED_PATCH_FIELDS)[number]>>;
export type ChatRegistryResolvedEntry = { id: string } & ChatRegistryEntry;
export type ChatRemovedCallback = (chatId: string) => void;
export type ChatReadUpdatedCallback = (chatId: string, lastReadAt: string | null | undefined) => void;
export type ResolveNativePath = (session: ChatRegistryEntry) => Promise<string | null>;

export interface IChatRegistry {
  init(): Promise<ChatRegistrySnapshot>;
  getRegistry(): ChatRegistrySnapshot;
  reconcileSessions(resolveNativePath: ResolveNativePath): Promise<boolean>;
  listAllChats(): Record<string, ChatRegistryEntry>;
  getChat(id: string): ChatRegistryEntry | null;
  addChat(entry: NewChatRegistryEntry): boolean;
  updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry | null;
  removeChat(id: string): boolean;
  getChatByNativePath(nativePath: string | null | undefined): [string, ChatRegistryEntry] | null;
  getChatByAgentSessionId(agentSessionId: string | null | undefined): [string, ChatRegistryEntry] | null;
  saveRegistry(registry: ChatRegistrySnapshot): Promise<void>;
  flush(): Promise<void>;
  onChatRemoved(cb: ChatRemovedCallback): void;
  onChatReadUpdated(cb: ChatReadUpdatedCallback): void;
}

function createEmptyRegistry(): ChatRegistrySnapshot {
  return { version: 1, sessions: {} };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRegistryModes(entry: {
  permissionMode?: unknown;
  thinkingMode?: unknown;
  claudeThinkingMode?: unknown;
  ampAgentMode?: unknown;
}): Pick<ChatRegistryEntry, 'permissionMode' | 'thinkingMode' | 'claudeThinkingMode' | 'ampAgentMode'> {
  return {
    permissionMode: normalizePermissionMode(entry.permissionMode),
    thinkingMode: normalizeThinkingMode(entry.thinkingMode),
    claudeThinkingMode: normalizeClaudeThinkingMode(entry.claudeThinkingMode),
    ampAgentMode: normalizeAmpAgentMode(entry.ampAgentMode),
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
  const value = rawEntry.agentId ?? rawEntry.provider;
  return typeof value === 'string' ? value as AgentName : '';
}

function normalizeChatRegistryEntry(rawEntry: Record<string, unknown>): ChatRegistryEntry {
  const agentSessionId = rawEntry.agentSessionId ?? rawEntry.providerSessionId;
  return {
    agentId: normalizeAgentId(rawEntry),
    agentSessionId: normalizeNullableString(agentSessionId),
    nativePath: normalizeNullableString(rawEntry.nativePath),
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

export class ChatRegistry extends EventEmitter implements IChatRegistry {
  #registry: ChatRegistrySnapshot | null = null;
  #pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  #nativePathCache = new Map<string, string>();
  #workspaceDir: string;

  constructor(workspaceDir: string) {
    super();
    this.#workspaceDir = workspaceDir;
  }

  #emitChatRemoved(id: string): void { this.emit('chat-removed', id); }
  onChatRemoved(cb: ChatRemovedCallback): void { this.on('chat-removed', cb); }

  #emitChatReadUpdated(id: string, lastReadAt: string | null | undefined): void {
    this.emit('chat-read-updated', id, lastReadAt);
  }
  onChatReadUpdated(cb: ChatReadUpdatedCallback): void { this.on('chat-read-updated', cb); }

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
      const sessions: Record<string, ChatRegistryEntry> = {};
      for (const [chatId, rawEntry] of Object.entries(parsed.sessions)) {
        if (!isObjectRecord(rawEntry)) continue;
        sessions[chatId] = normalizeChatRegistryEntry(rawEntry);
      }
      this.#registry = {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        sessions,
      };
      return this.#registry;
    } catch (error: unknown) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        this.#registry = createEmptyRegistry();
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

  async reconcileSessions(resolveNativePath: ResolveNativePath): Promise<boolean> {
    const registry = this.getRegistry();
    const sessions = registry.sessions;
    let dirty = false;

    for (const [chatId, session] of Object.entries(sessions)) {
      if (!session?.agentSessionId) {
        console.warn(`sessions: discarding chat ${chatId} with missing agentSessionId`);
        if (session?.nativePath) this.#nativePathCache.delete(session.nativePath);
        delete sessions[chatId];
        dirty = true;
        continue;
      }

      if (session.nativePath) {
        if (isArtificialNativePath(session.nativePath)) continue;
        try {
          await fs.access(session.nativePath);
          continue;
        } catch {
          this.#nativePathCache.delete(session.nativePath);
        }
      }

      let resolvedPath: string | null;
      try {
        resolvedPath = await resolveNativePath(session);
      } catch (error) {
        console.warn(`sessions: nativePath reconciliation aborted at ${chatId}:`, (error as Error).message);
        break;
      }
      if (!resolvedPath) {
        if (session.agentId === 'codex' && session.nativePath) {
          console.warn(`sessions: preserving Codex chat ${chatId} with unresolved nativePath`);
          continue;
        }
        console.warn(`sessions: discarding chat ${chatId} with unresolved nativePath`);
        delete sessions[chatId];
        dirty = true;
        continue;
      }

      session.nativePath = resolvedPath;
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
    nativePath = null,
    tags = [],
    agentSessionId = null,
    nextForkOrdinal = 1,
    apiProviderId = null,
    modelEndpointId = null,
    modelProtocol = null,
    permissionMode = 'default',
    thinkingMode = 'none',
    claudeThinkingMode = 'auto',
    ampAgentMode = 'smart',
  }: NewChatRegistryEntry): boolean {
    if (!agentId) throw new Error('Agent not specified');
    if (!model) throw new Error('Model not specified');
    if (!projectPath) throw new Error('Project path not specified');
    const registry = this.getRegistry();
    if (id in registry.sessions) {
      throw new Error(`Chat with ID ${id} already exists`);
    }
    const normalizedModes = normalizeRegistryModes({ permissionMode, thinkingMode, claudeThinkingMode, ampAgentMode });
    registry.sessions[id] = {
      agentId,
      nativePath,
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
    this.#scheduleRegistrySave();
    return true;
  }

  updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry | null {
    const registry = this.getRegistry();
    const existing = registry.sessions[id];
    if (!existing) return null;
    const normalizedPatch: ChatRegistryPatch = { ...patch };
    if ('permissionMode' in normalizedPatch) {
      normalizedPatch.permissionMode = normalizePermissionMode(normalizedPatch.permissionMode);
    }
    if ('thinkingMode' in normalizedPatch) {
      normalizedPatch.thinkingMode = normalizeThinkingMode(normalizedPatch.thinkingMode);
    }
    if ('claudeThinkingMode' in normalizedPatch) {
      normalizedPatch.claudeThinkingMode = normalizeClaudeThinkingMode(normalizedPatch.claudeThinkingMode);
    }
    if ('ampAgentMode' in normalizedPatch) {
      normalizedPatch.ampAgentMode = normalizeAmpAgentMode(normalizedPatch.ampAgentMode);
    }
    if ('nextForkOrdinal' in normalizedPatch) {
      normalizedPatch.nextForkOrdinal = normalizeNextForkOrdinal(normalizedPatch.nextForkOrdinal);
    }
    for (const key of ALLOWED_PATCH_FIELDS) {
      if (key in normalizedPatch) {
        existing[key] = normalizedPatch[key] as never;
      }
    }
    this.#scheduleRegistrySave();
    if ('lastReadAt' in normalizedPatch) {
      this.#emitChatReadUpdated(id, normalizedPatch.lastReadAt);
    }
    return { id, ...existing };
  }

  removeChat(id: string): boolean {
    const registry = this.getRegistry();
    const entry = registry.sessions[id];
    if (!entry) return false;
    if (entry.nativePath) this.#nativePathCache.delete(entry.nativePath);
    delete registry.sessions[id];
    this.#emitChatRemoved(id);
    this.#scheduleRegistrySave();
    return true;
  }

  getChatByNativePath(nativePath: string | null | undefined): [string, ChatRegistryEntry] | null {
    const registry = this.#registry;
    if (!registry) {
      throw new Error('Registry cache not initialized. Call init() during startup.');
    }
    if (!nativePath) return null;
    const cachedMatch = this.#getFromNativePathCache(nativePath, registry.sessions);
    if (cachedMatch) return cachedMatch;

    for (const [id, entry] of Object.entries(registry.sessions)) {
      if (entry.nativePath === nativePath) {
        this.#addToNativePathCache(nativePath, id);
        return [id, entry];
      }
    }
    return null;
  }

  getChatByAgentSessionId(agentSessionId: string | null | undefined): [string, ChatRegistryEntry] | null {
    const registry = this.#registry;
    if (!registry) {
      throw new Error('Registry cache not initialized. Call init() during startup.');
    }
    if (!agentSessionId) return null;
    for (const [id, entry] of Object.entries(registry.sessions)) {
      if (entry.agentSessionId === agentSessionId) {
        return [id, entry];
      }
    }
    return null;
  }

  async saveRegistry(registry: ChatRegistrySnapshot): Promise<void> {
    await fs.mkdir(this.#workspaceDir, { recursive: true });
    const target = this.#sessionsFilePath();
    const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const tmp = path.join(this.#workspaceDir, `chats.json.tmp.${suffix}`);
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(tmp, target);
    this.#registry = registry;
  }

  // Flushes any pending registry save immediately. Called during shutdown.
  async flush(): Promise<void> {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
      await this.saveRegistry(this.#registry || createEmptyRegistry());
    }
  }

  #scheduleRegistrySave(): void {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    const delayMs = 1000 + Math.floor(Math.random() * 9001);
    this.#pendingSaveTimer = setTimeout(() => {
      this.#pendingSaveTimer = null;
      this.saveRegistry(this.#registry || createEmptyRegistry()).catch((error: Error) => {
        console.warn('sessions: failed to persist registry:', error.message);
      });
    }, delayMs);
  }

  #addToNativePathCache(nativePath: string, chatId: string): void {
    if (!nativePath || !chatId) return;
    if (this.#nativePathCache.has(nativePath)) this.#nativePathCache.delete(nativePath);
    this.#nativePathCache.set(nativePath, chatId);
    if (this.#nativePathCache.size > NATIVE_PATH_LRU_MAX) {
      const oldest = this.#nativePathCache.keys().next().value;
      if (oldest) this.#nativePathCache.delete(oldest);
    }
  }

  #getFromNativePathCache(
    nativePath: string,
    sessions: Record<string, ChatRegistryEntry>,
  ): [string, ChatRegistryEntry] | null {
    const cachedChatId = this.#nativePathCache.get(nativePath);
    if (!cachedChatId) return null;
    const cachedEntry = sessions[cachedChatId];
    if (!cachedEntry?.nativePath || cachedEntry.nativePath !== nativePath) {
      this.#nativePathCache.delete(nativePath);
      return null;
    }
    this.#nativePathCache.delete(nativePath);
    this.#nativePathCache.set(nativePath, cachedChatId);
    return [cachedChatId, cachedEntry];
  }
}
