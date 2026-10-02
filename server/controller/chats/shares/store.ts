// Persistent store for shared chat snapshots. Keeps a small share index in
// shared-chats.json and, per token, a snapshot with one message per line and its
// plain-text transcript, both rendered on the transcript rendering Worker.

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isRecord } from '../../../../common/json.js';
import { AtomicJsonWriteError, writeFileAtomic, writeJsonFileAtomic } from '../../../common/json-file-store.js';
import { DomainError } from '../../../common/domain-error.js';
import { parseStoredJson } from '../../../common/stored-json.js';
import { createLogger } from '../../../common/log.js';
import { hasNodeErrorCode } from '../../../common/errors.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import type { StoredLedgerRow } from '../../ledger/codec.js';
import {
  decodeLegacyShareSnapshot,
  decodeShareSnapshot,
  decodeShareSnapshotHeader,
  isValidShareToken,
  normalizeShareIndexEntry,
  type ShareIndexEntry,
  type ShareSnapshotHeader,
} from './snapshot-format.js';
import type { RenderedShareSnapshot } from '../transcript-rendering/tasks.js';
import type { TranscriptRendering } from '../transcript-rendering/client.js';
import { readShareSnapshotRange, type SelectShareMessageRange } from './snapshot-reader.js';

const logger = createLogger('chats:share-store');

const SHARE_INDEX_VERSION = 2;
const SHARE_SNAPSHOT_CACHE_LIMIT = 50;
const SHARE_SNAPSHOT_CACHE_BYTES = 16 * 1024 * 1024;
const SHARE_SNAPSHOT_CACHE_TTL_MS = 10 * 60 * 1000;
// A snapshot's header is its first line; a read this long holds it.
const HEADER_READ_BYTES = 64 * 1024;

async function repairSharePermissions(
  targetPath: string,
  mode: number,
  description: string,
): Promise<void> {
  if (process.platform === 'win32') return;
  await fs.chmod(targetPath, mode).catch((error: unknown) => {
    logger.warn(`share-store: failed to repair ${description} permissions:`, (error as Error).message);
  });
}

interface ShareStoreIndex {
  version: 2;
  shares: Record<string, ShareIndexEntry>;
}

interface ShareStoreOptions {
  readonly rendering: Pick<TranscriptRendering, 'renderShareSnapshot' | 'convertShareSnapshot'>;
  readonly now?: () => number;
  readonly cacheLimit?: number;
  readonly cacheBytes?: number;
  readonly cacheTtlMs?: number;
}

export interface SharedChatMessages {
  readonly header: ShareSnapshotHeader;
  // Each message as its stored JSON, so a page is served without parsing it.
  readonly messages: readonly string[];
}

export type SharePublication = Omit<ShareSnapshotHeader, 'shareToken' | 'messageCount'>;

interface CachedShareMessages {
  readonly shared: SharedChatMessages;
  readonly bytes: number;
  lastAccessAt: number;
}

export interface IShareStore {
  init(): Promise<void>;
  // Keeps the token of the chat's existing share, so its links keep working.
  publish(
    chatId: string,
    publication: SharePublication,
    rows: readonly StoredLedgerRow[],
    signal?: AbortSignal,
  ): Promise<ShareIndexEntry>;
  getEntryByChatId(chatId: string): ShareIndexEntry | null;
  getHeader(token: string): Promise<ShareSnapshotHeader | null>;
  getMessages(token: string, select?: SelectShareMessageRange): Promise<SharedChatMessages | null>;
  getTextPath(token: string): Promise<string | null>;
  revokeShareByChatId(chatId: string): Promise<boolean>;
}

function createEmptyIndex(): ShareStoreIndex {
  return { version: SHARE_INDEX_VERSION, shares: {} };
}

function indexEntryFromHeader(header: ShareSnapshotHeader): ShareIndexEntry {
  return {
    shareToken: header.shareToken,
    chatId: header.chatId,
    title: header.title,
    agentId: header.agentId,
    model: header.model,
    projectPath: header.projectPath,
    sharedAt: header.sharedAt,
  };
}

export class ShareStore implements IShareStore {
  #index: ShareStoreIndex | null = null;
  #chatIdIndex = new Map<string, string>();
  #snapshotCache = new Map<string, CachedShareMessages>();
  // Serializes each chat's publications, revocations, and snapshot loads, which await
  // rendering and file writes between reading and updating the index.
  #chatLocks = new KeyedPromiseLock();
  #indexLock = new KeyedPromiseLock();
  #durabilityUnknown = false;
  #workspaceDir: string;
  #rendering: ShareStoreOptions['rendering'];
  #now: () => number;
  #cacheLimit: number;
  #cacheBytes: number;
  #cacheTtlMs: number;

  constructor(workspaceDir: string, options: ShareStoreOptions) {
    this.#workspaceDir = workspaceDir;
    this.#rendering = options.rendering;
    this.#now = options.now ?? (() => Date.now());
    this.#cacheLimit = options.cacheLimit ?? SHARE_SNAPSHOT_CACHE_LIMIT;
    this.#cacheBytes = options.cacheBytes ?? SHARE_SNAPSHOT_CACHE_BYTES;
    this.#cacheTtlMs = options.cacheTtlMs ?? SHARE_SNAPSHOT_CACHE_TTL_MS;
  }

  #filePath(): string {
    return path.join(this.#workspaceDir, 'shared-chats.json');
  }

  #sharesDir(): string {
    return path.join(this.#workspaceDir, 'shares');
  }

  #shareFilePath(token: string, extension: 'ndjson' | 'txt' | 'json'): string {
    if (!isValidShareToken(token)) {
      throw new Error('Invalid share token');
    }
    return path.join(this.#sharesDir(), `${token}.${extension}`);
  }

  async init(): Promise<void> {
    if (this.#index) return;
    await fs.mkdir(this.#sharesDir(), { recursive: true, mode: 0o700 });
    await repairSharePermissions(this.#sharesDir(), 0o700, 'shares directory');
    let parsed: unknown;
    try {
      const raw = await fs.readFile(this.#filePath(), 'utf8');
      await repairSharePermissions(this.#filePath(), 0o600, 'shared-chats.json');
      parsed = parseStoredJson(raw, 'shared-chats.json');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('share-store: failed to read shared-chats.json:', (error as Error).message);
      }
      this.#index = createEmptyIndex();
      this.#rebuildIndex();
      return;
    }
    if (isRecord(parsed) && parsed.version === SHARE_INDEX_VERSION && isRecord(parsed.shares)) {
      this.#index = this.#normalizeIndex(parsed.shares);
    } else if (isRecord(parsed) && isRecord(parsed.shares)) {
      this.#index = await this.#migrateLegacyShares(parsed.shares);
    } else {
      this.#index = createEmptyIndex();
    }
    this.#rebuildIndex();
  }

  #normalizeIndex(shares: Record<string, unknown>): ShareStoreIndex {
    const index = createEmptyIndex();
    for (const [token, rawEntry] of Object.entries(shares)) {
      const entry = normalizeShareIndexEntry(token, rawEntry);
      if (entry) index.shares[entry.shareToken] = entry;
    }
    return index;
  }

  // Writes each embedded snapshot in the single-document format, which the first read of
  // the share converts.
  async #migrateLegacyShares(shares: Record<string, unknown>): Promise<ShareStoreIndex> {
    const index = createEmptyIndex();
    for (const [token, rawSnapshot] of Object.entries(shares)) {
      const snapshot = decodeLegacyShareSnapshot(token, rawSnapshot);
      if (!snapshot) continue;
      index.shares[snapshot.shareToken] = indexEntryFromHeader({ ...snapshot, messageCount: snapshot.messages.length });
      await writeJsonFileAtomic(this.#shareFilePath(snapshot.shareToken, 'json'), snapshot, { mode: 0o600 });
    }
    await writeJsonFileAtomic(this.#filePath(), index, { mode: 0o600 });
    this.#index = index;
    return index;
  }

  #rebuildIndex(): void {
    this.#chatIdIndex.clear();
    if (!this.#index) return;
    for (const [token, entry] of Object.entries(this.#index.shares)) {
      this.#chatIdIndex.set(entry.chatId, token);
    }
  }

  async #commit(change: (shares: ShareStoreIndex['shares']) => void): Promise<void> {
    await this.#indexLock.runExclusive('index', async () => {
      const current = this.#requireIndex();
      const candidate: ShareStoreIndex = { version: SHARE_INDEX_VERSION, shares: { ...current.shares } };
      change(candidate.shares);
      try {
        await writeJsonFileAtomic(this.#filePath(), candidate, { mode: 0o600 });
      } catch (error) {
        if (error instanceof AtomicJsonWriteError && error.renamed) {
          this.#durabilityUnknown = true;
          this.#snapshotCache.clear();
        }
        throw error;
      }
      this.#index = candidate;
      this.#rebuildIndex();
    });
  }

  #assertAvailable(): void {
    if (this.#durabilityUnknown) {
      throw new DomainError('SHARE_STORAGE_UNAVAILABLE', 'Share index durability is unknown. Restart the controller before accessing shares.', 503);
    }
  }

  #requireIndex(): ShareStoreIndex {
    this.#assertAvailable();
    if (!this.#index) throw new Error('ShareStore not initialized');
    return this.#index;
  }

  async publish(
    chatId: string,
    publication: SharePublication,
    rows: readonly StoredLedgerRow[],
    signal?: AbortSignal,
  ): Promise<ShareIndexEntry> {
    this.#requireIndex();
    return this.#chatLocks.runExclusive(chatId, async () => {
      this.#assertAvailable();
      const token = this.#chatIdIndex.get(chatId) ?? crypto.randomBytes(24).toString('base64url');
      const rendered = await this.#rendering.renderShareSnapshot(
        { header: { ...publication, shareToken: token }, rows },
        signal,
      );
      this.#assertAvailable();
      await this.#writeRendered(token, rendered);
      const entry = indexEntryFromHeader(rendered.header);
      this.#snapshotCache.delete(token);
      await this.#commit(shares => { shares[token] = entry; });
      return entry;
    }, signal);
  }

  getEntryByChatId(chatId: string): ShareIndexEntry | null {
    this.#assertAvailable();
    const token = this.#chatIdIndex.get(chatId);
    return token ? this.#index?.shares[token] ?? null : null;
  }

  // Reads only the snapshot's first line when its messages are not cached.
  async getHeader(token: string): Promise<ShareSnapshotHeader | null> {
    if (!this.#hasShare(token)) return null;
    const cached = this.#cachedMessages(token);
    if (cached) return cached.header;
    const header = await this.#readHeader(token);
    this.#assertAvailable();
    return header ?? (await this.getMessages(token))?.header ?? null;
  }

  async getMessages(token: string, select?: SelectShareMessageRange): Promise<SharedChatMessages | null> {
    const entry = this.#shareEntry(token);
    if (!entry) return null;
    const cached = this.#cachedMessages(token);
    if (cached) return selectMessages(cached, select);
    return this.#chatLocks.runExclusive(entry.chatId, async () => {
      if (this.#shareEntry(token)?.chatId !== entry.chatId) return null;
      const cached = this.#cachedMessages(token);
      if (cached) return selectMessages(cached, select);
      if (select) {
        try {
          const page = await readShareSnapshotRange(this.#shareFilePath(token, 'ndjson'), token, select);
          await repairSharePermissions(this.#shareFilePath(token, 'ndjson'), 0o600, 'share snapshot');
          this.#assertAvailable();
          return page;
        } catch (error) {
          if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
          const converted = await this.#convertLegacySnapshot(token);
          this.#assertAvailable();
          return converted ? selectMessages(converted, select) : null;
        }
      }
      const loaded = await this.#loadSnapshot(token);
      return loaded ? this.#cacheMessages(token, loaded) : null;
    });
  }

  async getTextPath(token: string): Promise<string | null> {
    if (!this.#hasShare(token)) return null;
    const textPath = this.#shareFilePath(token, 'txt');
    if (await Bun.file(textPath).exists()) return textPath;
    // Reading a share converts an older snapshot, which writes its plain text.
    if (!(await this.getMessages(token))) return null;
    return await Bun.file(textPath).exists() ? textPath : null;
  }

  async revokeShareByChatId(chatId: string): Promise<boolean> {
    this.#assertAvailable();
    if (!this.#index) return false;
    return this.#chatLocks.runExclusive(chatId, async () => {
      this.#assertAvailable();
      const token = this.#chatIdIndex.get(chatId);
      if (!token) return false;

      await this.#commit(shares => { delete shares[token]; });
      this.#snapshotCache.delete(token);
      for (const extension of ['ndjson', 'txt', 'json'] as const) {
        await this.#removeFile(this.#shareFilePath(token, extension));
      }
      return true;
    });
  }

  #hasShare(token: string): boolean {
    return this.#shareEntry(token) !== null;
  }

  #shareEntry(token: string): ShareIndexEntry | null {
    this.#assertAvailable();
    if (!this.#index || !isValidShareToken(token) || !Object.hasOwn(this.#index.shares, token)) return null;
    return this.#index.shares[token] ?? null;
  }

  // The snapshot goes last: its presence means the share needs no conversion, so it must
  // imply the plain text was written.
  async #writeRendered(token: string, rendered: RenderedShareSnapshot): Promise<void> {
    await writeFileAtomic(this.#shareFilePath(token, 'txt'), rendered.text, { mode: 0o600 });
    await writeFileAtomic(this.#shareFilePath(token, 'ndjson'), rendered.snapshot, { mode: 0o600 });
    await this.#removeFile(this.#shareFilePath(token, 'json'));
  }

  async #readHeader(token: string): Promise<ShareSnapshotHeader | null> {
    let start: string;
    try {
      start = await Bun.file(this.#shareFilePath(token, 'ndjson')).slice(0, HEADER_READ_BYTES).text();
    } catch (error: unknown) {
      if (hasNodeErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
    const end = start.indexOf('\n');
    return decodeShareSnapshotHeader(token, end < 0 ? start : start.slice(0, end));
  }

  async #loadSnapshot(token: string): Promise<SharedChatMessages | null> {
    const snapshotPath = this.#shareFilePath(token, 'ndjson');
    let text: string;
    try {
      text = await fs.readFile(snapshotPath, 'utf8');
    } catch (error: unknown) {
      if (hasNodeErrorCode(error, 'ENOENT')) return this.#convertLegacySnapshot(token);
      throw error;
    }
    await repairSharePermissions(snapshotPath, 0o600, 'share snapshot');
    const shared = decodeShareSnapshot(token, text);
    if (!shared) logger.warn('share-store: share snapshot is unreadable:', token);
    return shared;
  }

  // Converts a snapshot stored as one document on the rendering Worker, once.
  async #convertLegacySnapshot(token: string): Promise<SharedChatMessages | null> {
    let json: string;
    try {
      json = await fs.readFile(this.#shareFilePath(token, 'json'), 'utf8');
    } catch (error: unknown) {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
      await this.#commit(shares => { delete shares[token]; });
      return null;
    }
    const rendered = await this.#rendering.convertShareSnapshot(token, json);
    if (!rendered) return null;
    await this.#writeRendered(token, rendered);
    return decodeShareSnapshot(token, new TextDecoder().decode(rendered.snapshot));
  }

  async #removeFile(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch((error: unknown) => {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
    });
  }

  #cachedMessages(token: string): SharedChatMessages | null {
    const cached = this.#snapshotCache.get(token);
    const now = this.#now();
    if (cached && now - cached.lastAccessAt <= this.#cacheTtlMs) {
      cached.lastAccessAt = now;
      return cached.shared;
    }
    this.#snapshotCache.delete(token);
    return null;
  }

  #cacheMessages(token: string, shared: SharedChatMessages): SharedChatMessages {
    this.#assertAvailable();
    const bytes = 2 * JSON.stringify(shared.header).length
      + shared.messages.reduce((total, message) => total + 2 * message.length + 32, 0);
    if (bytes > this.#cacheBytes) return shared;
    this.#snapshotCache.set(token, { shared, bytes, lastAccessAt: this.#now() });
    this.#pruneSnapshotCache();
    return shared;
  }

  #pruneSnapshotCache(): void {
    const now = this.#now();
    for (const [token, cached] of this.#snapshotCache) {
      if (now - cached.lastAccessAt > this.#cacheTtlMs) {
        this.#snapshotCache.delete(token);
      }
    }

    const entries = [...this.#snapshotCache.entries()]
      .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    let bytes = entries.reduce((total, [, cached]) => total + cached.bytes, 0);
    for (const [token, cached] of entries) {
      if (this.#snapshotCache.size <= this.#cacheLimit && bytes <= this.#cacheBytes) break;
      this.#snapshotCache.delete(token);
      bytes -= cached.bytes;
    }
  }
}

function selectMessages(shared: SharedChatMessages, select?: SelectShareMessageRange): SharedChatMessages {
  if (!select) return shared;
  const { start, end } = select(shared.header);
  return { header: shared.header, messages: shared.messages.slice(start, end) };
}
