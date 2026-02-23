// Chat registry. Manages a single chats.json file that maps
// chat IDs to provider-specific session metadata.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const NATIVE_PATH_LRU_MAX = 64;
const ALLOWED_PATCH_FIELDS = ['nativePath', 'projectPath', 'tags', 'providerSessionId', 'model', 'lastReadAt', 'permissionMode', 'thinkingMode'];

function createEmptyRegistry() {
  return { version: 1, sessions: {} };
}

export class ChatRegistry extends EventEmitter {
  #registry = null;
  #pendingSaveTimer = null;
  #nativePathCache = new Map();
  #workspaceDir;

  constructor(workspaceDir) {
    super();
    this.#workspaceDir = workspaceDir;
  }

  #emitChatRemoved(id) { this.emit('chat-removed', id); }
  onChatRemoved(cb) { this.on('chat-removed', cb); }

  #emitChatReadUpdated(id, lastReadAt) { this.emit('chat-read-updated', id, lastReadAt); }
  onChatReadUpdated(cb) { this.on('chat-read-updated', cb); }

  #sessionsFilePath() {
    return path.join(this.#workspaceDir, 'chats.json');
  }

  async init() {
    if (this.#registry) return this.#registry;
    try {
      const raw = await fs.readFile(this.#sessionsFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      if (!parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      this.#registry = {
        version: parsed.version || 1,
        sessions: parsed.sessions,
      };
      return this.#registry;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#registry = createEmptyRegistry();
        return this.#registry;
      }
      throw error;
    }
  }

  getRegistry() {
    if (!this.#registry) {
      throw new Error('Registry cache not initialized. Call init() during startup.');
    }
    return this.#registry;
  }

  // Returns a shallow copy of all sessions.
  listAllChats() {
    const registry = this.getRegistry();
    return Object.assign({}, registry.sessions || {});
  }

  getChat(id) {
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
  }) {
    if (!provider) throw new Error('Provider not specified');
    if (!model) throw new Error('Model not specified');
    if (!projectPath) throw new Error('Project path not specified');
    const registry = this.getRegistry();
    if (id in registry.sessions) {
      throw new Error(`Chat with ID ${id} already exists`);
    }
    registry.sessions[id] = { provider, nativePath, projectPath, tags, providerSessionId, model, permissionMode, thinkingMode };
    this.#scheduleRegistrySave();
    return true;
  }

  updateChat(id, patch) {
    const registry = this.getRegistry();
    const existing = registry.sessions[id];
    if (!existing) return null;
    for (const key of ALLOWED_PATCH_FIELDS) {
      if (key in patch) existing[key] = patch[key];
    }
    this.#scheduleRegistrySave();
    if ('lastReadAt' in patch) {
      this.#emitChatReadUpdated(id, patch.lastReadAt);
    }
    return { id, ...existing };
  }

  removeChat(id) {
    const registry = this.getRegistry();
    const entry = registry.sessions[id];
    if (!entry) return false;
    if (entry.nativePath) this.#nativePathCache.delete(entry.nativePath);
    delete registry.sessions[id];
    this.#emitChatRemoved(id);
    this.#scheduleRegistrySave();
    return true;
  }

  getChatByNativePath(nativePath) {
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

  getChatByProviderSessionId(providerSessionId) {
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

  async saveRegistry(registry) {
    await fs.mkdir(this.#workspaceDir, { recursive: true });
    const target = this.#sessionsFilePath();
    const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const tmp = path.join(this.#workspaceDir, `chats.json.tmp.${suffix}`);
    await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
    await fs.rename(tmp, target);
    this.#registry = registry;
  }

  // Flushes any pending registry save immediately. Called during shutdown.
  async flush() {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
      await this.saveRegistry(this.#registry || createEmptyRegistry());
    }
  }

  #scheduleRegistrySave() {
    if (this.#pendingSaveTimer) {
      clearTimeout(this.#pendingSaveTimer);
      this.#pendingSaveTimer = null;
    }
    const delayMs = 1000 + Math.floor(Math.random() * 9001);
    this.#pendingSaveTimer = setTimeout(() => {
      this.#pendingSaveTimer = null;
      this.saveRegistry(this.#registry || createEmptyRegistry()).catch((error) => {
        console.warn('sessions: failed to persist registry:', error.message);
      });
    }, delayMs);
  }

  #addToNativePathCache(nativePath, chatId) {
    if (!nativePath || !chatId) return;
    if (this.#nativePathCache.has(nativePath)) this.#nativePathCache.delete(nativePath);
    this.#nativePathCache.set(nativePath, chatId);
    if (this.#nativePathCache.size > NATIVE_PATH_LRU_MAX) {
      const oldest = this.#nativePathCache.keys().next().value;
      if (oldest) this.#nativePathCache.delete(oldest);
    }
  }

  #getFromNativePathCache(nativePath, sessions) {
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
