// Persistent store for shared chat snapshots.
// Maps share tokens to frozen message snapshots, stored in shared-chats.json.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { SharedChatSnapshot } from '../../common/share-types.ts';

interface ShareStoreData {
  version: number;
  shares: Record<string, SharedChatSnapshot>;
}

export interface IShareStore {
  init(): Promise<void>;
  createShare(chatId: string, snapshot: Omit<SharedChatSnapshot, 'shareToken'>): Promise<SharedChatSnapshot>;
  getShare(token: string): SharedChatSnapshot | null;
  getShareByChatId(chatId: string): SharedChatSnapshot | null;
  revokeShareByChatId(chatId: string): Promise<boolean>;
}

function createEmptyStore(): ShareStoreData {
  return { version: 1, shares: {} };
}

export class ShareStore implements IShareStore {
  #data: ShareStoreData | null = null;
  #chatIdIndex = new Map<string, string>();
  #workspaceDir: string;

  constructor(workspaceDir: string) {
    this.#workspaceDir = workspaceDir;
  }

  #filePath(): string {
    return path.join(this.#workspaceDir, 'shared-chats.json');
  }

  async init(): Promise<void> {
    if (this.#data) return;
    try {
      const raw = await fs.readFile(this.#filePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.shares) {
        this.#data = parsed as ShareStoreData;
      } else {
        this.#data = createEmptyStore();
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#data = createEmptyStore();
      } else {
        console.warn('share-store: failed to read shared-chats.json:', (err as Error).message);
        this.#data = createEmptyStore();
      }
    }
    this.#rebuildIndex();
  }

  #rebuildIndex(): void {
    this.#chatIdIndex.clear();
    if (!this.#data) return;
    for (const [token, snapshot] of Object.entries(this.#data.shares)) {
      this.#chatIdIndex.set(snapshot.chatId, token);
    }
  }

  async #persist(): Promise<void> {
    if (!this.#data) return;
    const tmpPath = this.#filePath() + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(this.#data, null, 2), 'utf8');
    await fs.rename(tmpPath, this.#filePath());
  }

  async createShare(chatId: string, partial: Omit<SharedChatSnapshot, 'shareToken'>): Promise<SharedChatSnapshot> {
    if (!this.#data) throw new Error('ShareStore not initialized');

    // Idempotent: return existing share if one exists for this chat.
    const existingToken = this.#chatIdIndex.get(chatId);
    if (existingToken && this.#data.shares[existingToken]) {
      return this.#data.shares[existingToken];
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const snapshot: SharedChatSnapshot = { ...partial, shareToken: token };

    this.#data.shares[token] = snapshot;
    this.#chatIdIndex.set(chatId, token);
    await this.#persist();

    return snapshot;
  }

  getShare(token: string): SharedChatSnapshot | null {
    return this.#data?.shares[token] ?? null;
  }

  getShareByChatId(chatId: string): SharedChatSnapshot | null {
    const token = this.#chatIdIndex.get(chatId);
    if (!token) return null;
    return this.#data?.shares[token] ?? null;
  }

  async revokeShareByChatId(chatId: string): Promise<boolean> {
    if (!this.#data) return false;
    const token = this.#chatIdIndex.get(chatId);
    if (!token) return false;

    delete this.#data.shares[token];
    this.#chatIdIndex.delete(chatId);
    await this.#persist();
    return true;
  }
}
