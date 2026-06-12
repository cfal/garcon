// Persistent store for shared chat snapshots.
// Keeps a small share index in shared-chats.json and stores snapshots per token.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { SharedChatSnapshot } from '../../common/share-types.ts';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';

const SHARE_INDEX_VERSION = 2;
const SHARE_SNAPSHOT_CACHE_LIMIT = 50;
const SHARE_SNAPSHOT_CACHE_TTL_MS = 10 * 60 * 1000;

type ShareIndexEntry = Omit<SharedChatSnapshot, 'messages'>;

interface ShareStoreIndex {
  version: 2;
  shares: Record<string, ShareIndexEntry>;
}

interface ShareStoreOptions {
  now?: () => number;
  cacheLimit?: number;
  cacheTtlMs?: number;
}

interface CachedShareSnapshot {
  snapshot: SharedChatSnapshot;
  lastAccessAt: number;
}

export interface IShareStore {
  init(): Promise<void>;
  createShare(chatId: string, snapshot: Omit<SharedChatSnapshot, 'shareToken'>): Promise<SharedChatSnapshot>;
  updateShare(chatId: string, partial: Omit<SharedChatSnapshot, 'shareToken'>): Promise<SharedChatSnapshot>;
  getShare(token: string): Promise<SharedChatSnapshot | null>;
  getShareByChatId(chatId: string): Promise<SharedChatSnapshot | null>;
  revokeShareByChatId(chatId: string): Promise<boolean>;
}

function createEmptyIndex(): ShareStoreIndex {
  return { version: SHARE_INDEX_VERSION, shares: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(token);
}

function indexEntryFromSnapshot(snapshot: SharedChatSnapshot): ShareIndexEntry {
  return {
    shareToken: snapshot.shareToken,
    chatId: snapshot.chatId,
    title: snapshot.title,
    agentId: snapshot.agentId,
    model: snapshot.model,
    projectPath: snapshot.projectPath,
    sharedAt: snapshot.sharedAt,
  };
}

function snapshotFromPartial(
  shareToken: string,
  partial: Omit<SharedChatSnapshot, 'shareToken'>,
): SharedChatSnapshot {
  return { ...partial, shareToken };
}

function normalizeIndexEntry(token: string, value: unknown): ShareIndexEntry | null {
  if (!isRecord(value)) return null;
  const shareToken = typeof value.shareToken === 'string' ? value.shareToken : token;
  if (!isValidShareToken(shareToken)) return null;
  const chatId = typeof value.chatId === 'string' ? value.chatId : null;
  const title = typeof value.title === 'string' ? value.title : null;
  const agentId = typeof value.agentId === 'string' ? value.agentId : null;
  const model = typeof value.model === 'string' ? value.model : null;
  const projectPath = typeof value.projectPath === 'string' ? value.projectPath : null;
  const sharedAt = typeof value.sharedAt === 'string' ? value.sharedAt : null;
  if (!chatId || !title || !agentId || !model || !projectPath || !sharedAt) return null;
  return { shareToken, chatId, title, agentId, model, projectPath, sharedAt };
}

function normalizeSnapshot(token: string, value: unknown): SharedChatSnapshot | null {
  if (!isRecord(value)) return null;
  const entry = normalizeIndexEntry(token, value);
  if (!entry) return null;
  const messages = Array.isArray(value.messages) ? value.messages : [];
  return { ...entry, messages };
}

export class ShareStore implements IShareStore {
  #index: ShareStoreIndex | null = null;
  #chatIdIndex = new Map<string, string>();
  #snapshotCache = new Map<string, CachedShareSnapshot>();
  #workspaceDir: string;
  #now: () => number;
  #cacheLimit: number;
  #cacheTtlMs: number;

  constructor(workspaceDir: string, options: ShareStoreOptions = {}) {
    this.#workspaceDir = workspaceDir;
    this.#now = options.now ?? (() => Date.now());
    this.#cacheLimit = options.cacheLimit ?? SHARE_SNAPSHOT_CACHE_LIMIT;
    this.#cacheTtlMs = options.cacheTtlMs ?? SHARE_SNAPSHOT_CACHE_TTL_MS;
  }

  #filePath(): string {
    return path.join(this.#workspaceDir, 'shared-chats.json');
  }

  #sharesDir(): string {
    return path.join(this.#workspaceDir, 'shares');
  }

  #snapshotFilePath(token: string): string {
    if (!isValidShareToken(token)) {
      throw new Error('Invalid share token');
    }
    return path.join(this.#sharesDir(), `${token}.json`);
  }

  async init(): Promise<void> {
    if (this.#index) return;
    try {
      const raw = await fs.readFile(this.#filePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.version === SHARE_INDEX_VERSION && isRecord(parsed.shares)) {
        this.#index = this.#normalizeIndex(parsed.shares);
      } else if (isRecord(parsed) && isRecord(parsed.shares)) {
        this.#index = await this.#migrateLegacyShares(parsed.shares);
      } else {
        this.#index = createEmptyIndex();
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#index = createEmptyIndex();
      } else {
        console.warn('share-store: failed to read shared-chats.json:', (err as Error).message);
        this.#index = createEmptyIndex();
      }
    }
    this.#rebuildIndex();
  }

  #normalizeIndex(shares: Record<string, unknown>): ShareStoreIndex {
    const index = createEmptyIndex();
    for (const [token, rawEntry] of Object.entries(shares)) {
      const entry = normalizeIndexEntry(token, rawEntry);
      if (entry) index.shares[entry.shareToken] = entry;
    }
    return index;
  }

  async #migrateLegacyShares(shares: Record<string, unknown>): Promise<ShareStoreIndex> {
    const index = createEmptyIndex();
    for (const [token, rawSnapshot] of Object.entries(shares)) {
      const snapshot = normalizeSnapshot(token, rawSnapshot);
      if (!snapshot) continue;
      index.shares[snapshot.shareToken] = indexEntryFromSnapshot(snapshot);
      await this.#writeSnapshot(snapshot);
    }
    this.#index = index;
    await this.#persist();
    return index;
  }

  #rebuildIndex(): void {
    this.#chatIdIndex.clear();
    if (!this.#index) return;
    for (const [token, entry] of Object.entries(this.#index.shares)) {
      this.#chatIdIndex.set(entry.chatId, token);
    }
  }

  async #persist(): Promise<void> {
    if (!this.#index) return;
    await writeJsonFileAtomic(this.#filePath(), this.#index);
  }

  async #writeSnapshot(snapshot: SharedChatSnapshot): Promise<void> {
    await writeJsonFileAtomic(this.#snapshotFilePath(snapshot.shareToken), snapshot);
  }

  #cacheSnapshot(snapshot: SharedChatSnapshot): SharedChatSnapshot {
    this.#snapshotCache.set(snapshot.shareToken, {
      snapshot,
      lastAccessAt: this.#now(),
    });
    this.#pruneSnapshotCache();
    return snapshot;
  }

  #pruneSnapshotCache(): void {
    const now = this.#now();
    for (const [token, cached] of this.#snapshotCache) {
      if (now - cached.lastAccessAt > this.#cacheTtlMs) {
        this.#snapshotCache.delete(token);
      }
    }

    if (this.#snapshotCache.size <= this.#cacheLimit) return;
    const entries = [...this.#snapshotCache.entries()]
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    for (const [token] of entries) {
      if (this.#snapshotCache.size <= this.#cacheLimit) break;
      this.#snapshotCache.delete(token);
    }
  }

  async createShare(chatId: string, partial: Omit<SharedChatSnapshot, 'shareToken'>): Promise<SharedChatSnapshot> {
    if (!this.#index) throw new Error('ShareStore not initialized');

    // Idempotent: return existing share if one exists for this chat.
    const existingToken = this.#chatIdIndex.get(chatId);
    if (existingToken && this.#index.shares[existingToken]) {
      const existing = await this.getShare(existingToken);
      if (existing) return existing;
      delete this.#index.shares[existingToken];
      this.#chatIdIndex.delete(chatId);
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const snapshot = snapshotFromPartial(token, partial);

    this.#index.shares[token] = indexEntryFromSnapshot(snapshot);
    this.#chatIdIndex.set(chatId, token);
    await this.#writeSnapshot(snapshot);
    await this.#persist();

    return this.#cacheSnapshot(snapshot);
  }

  async updateShare(chatId: string, partial: Omit<SharedChatSnapshot, 'shareToken'>): Promise<SharedChatSnapshot> {
    if (!this.#index) throw new Error('ShareStore not initialized');

    const existingToken = this.#chatIdIndex.get(chatId);
    if (!existingToken || !this.#index.shares[existingToken]) {
      throw new Error('No existing share for this chat');
    }

    const snapshot = snapshotFromPartial(existingToken, partial);
    this.#index.shares[existingToken] = indexEntryFromSnapshot(snapshot);
    this.#chatIdIndex.set(chatId, existingToken);
    await this.#writeSnapshot(snapshot);
    await this.#persist();

    return this.#cacheSnapshot(snapshot);
  }

  async getShare(token: string): Promise<SharedChatSnapshot | null> {
    if (!this.#index || !isValidShareToken(token) || !this.#index.shares[token]) return null;

    const cached = this.#snapshotCache.get(token);
    const now = this.#now();
    if (cached && now - cached.lastAccessAt <= this.#cacheTtlMs) {
      cached.lastAccessAt = now;
      return cached.snapshot;
    }
    this.#snapshotCache.delete(token);

    try {
      const raw = await fs.readFile(this.#snapshotFilePath(token), 'utf8');
      const snapshot = normalizeSnapshot(token, JSON.parse(raw));
      return snapshot ? this.#cacheSnapshot(snapshot) : null;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const entry = this.#index.shares[token];
        delete this.#index.shares[token];
        if (entry) this.#chatIdIndex.delete(entry.chatId);
        await this.#persist();
        return null;
      }
      throw error;
    }
  }

  async getShareByChatId(chatId: string): Promise<SharedChatSnapshot | null> {
    const token = this.#chatIdIndex.get(chatId);
    if (!token) return null;
    return this.getShare(token);
  }

  async revokeShareByChatId(chatId: string): Promise<boolean> {
    if (!this.#index) return false;
    const token = this.#chatIdIndex.get(chatId);
    if (!token) return false;

    delete this.#index.shares[token];
    this.#chatIdIndex.delete(chatId);
    this.#snapshotCache.delete(token);
    await fs.unlink(this.#snapshotFilePath(token)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await this.#persist();
    return true;
  }
}
