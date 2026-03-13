// Chat registry. Manages a single chats.json file that maps
// chat IDs to provider-specific session metadata.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { ProviderName } from '../providers/types.js';

const NATIVE_PATH_LRU_MAX = 64;
const ALLOWED_PATCH_FIELDS = [
  'nativePath',
  'projectPath',
  'tags',
  'providerSessionId',
  'model',
  'lastReadAt',
  'permissionMode',
  'thinkingMode',
] as const;

export interface ChatRegistryEntry {
  provider: ProviderName;
  nativePath: string | null;
  projectPath: string;
  tags: string[];
  providerSessionId: string | null;
  model: string;
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
  provider: ProviderName;
  model: string;
  projectPath: string;
  nativePath?: string | null;
  tags?: string[];
  providerSessionId?: string | null;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
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
  getChatByProviderSessionId(providerSessionId: string | null | undefined): [string, ChatRegistryEntry] | null;
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
      this.#registry = {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        sessions: parsed.sessions as Record<string, ChatRegistryEntry>,
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
      if (!session?.providerSessionId) {
        console.warn(`sessions: discarding chat ${chatId} with missing providerSessionId`);
        if (session?.nativePath) this.#nativePathCache.delete(session.nativePath);
        delete sessions[chatId];
        dirty = true;
        continue;
      }

      if (session.nativePath) {
        if (session.provider === 'opencode') continue;
        try {
          await fs.access(session.nativePath);
          continue;
        } catch {
          this.#nativePathCache.delete(session.nativePath);
        }
      }

      const resolvedPath = await resolveNativePath(session).catch((error: Error) => {
        console.warn(`sessions: failed to reconcile nativePath for ${chatId}:`, error.message);
        return null;
      });
      if (!resolvedPath) {
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
    provider,
    model,
    projectPath,
    nativePath = null,
    tags = [],
    providerSessionId = null,
    permissionMode = 'default',
    thinkingMode = 'none',
  }: NewChatRegistryEntry): boolean {
    if (!provider) throw new Error('Provider not specified');
    if (!model) throw new Error('Model not specified');
    if (!projectPath) throw new Error('Project path not specified');
    const registry = this.getRegistry();
    if (id in registry.sessions) {
      throw new Error(`Chat with ID ${id} already exists`);
    }
    registry.sessions[id] = {
      provider,
      nativePath,
      projectPath,
      tags,
      providerSessionId,
      model,
      permissionMode,
      thinkingMode,
    };
    this.#scheduleRegistrySave();
    return true;
  }

  updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry | null {
    const registry = this.getRegistry();
    const existing = registry.sessions[id];
    if (!existing) return null;
    for (const key of ALLOWED_PATCH_FIELDS) {
      if (key in patch) {
        existing[key] = patch[key] as never;
      }
    }
    this.#scheduleRegistrySave();
    if ('lastReadAt' in patch) {
      this.#emitChatReadUpdated(id, patch.lastReadAt);
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

  getChatByProviderSessionId(providerSessionId: string | null | undefined): [string, ChatRegistryEntry] | null {
    const registry = this.#registry;
    if (!registry) {
      throw new Error('Registry cache not initialized. Call init() during startup.');
    }
    if (!providerSessionId) return null;
    for (const [id, entry] of Object.entries(registry.sessions)) {
      if (entry.providerSessionId === providerSessionId) {
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
