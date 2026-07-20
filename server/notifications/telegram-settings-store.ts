// Persists notification secrets in the Garcon config directory. Raw
// credentials stay server-side and are never returned in remote settings.

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { getConfigDir } from '../config.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TelegramBotIdentity, TelegramResolvedRecipient } from './telegram.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('notifications:telegram-settings-store');

const TELEGRAM_LINK_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_SETTINGS_WRITE_LOCK_KEY = 'telegram-settings';

interface TelegramSecrets {
  botToken: string;
  botId: number | null;
  botUsername: string;
  botFirstName: string;
  recipientUsername: string;
  recipientDisplayName: string;
  chatId: string;
  pendingLinkCode: string;
  pendingLinkCreatedAt: string;
  updateOffset: number | null;
}

interface NotificationSecretsSnapshot {
  version: 1;
  telegram: TelegramSecrets;
}

function emptySnapshot(): NotificationSecretsSnapshot {
  return {
    version: 1,
    telegram: {
      botToken: '',
      botId: null,
      botUsername: '',
      botFirstName: '',
      recipientUsername: '',
      recipientDisplayName: '',
      chatId: '',
      pendingLinkCode: '',
      pendingLinkCreatedAt: '',
      updateOffset: null,
    },
  };
}

export interface TelegramPublicStatus {
  botTokenAvailable: boolean;
  botUsername: string | null;
  botFirstName: string | null;
  recipientUsername: string | null;
  recipientDisplayName: string | null;
  recipientLinked: boolean;
  pendingLink: boolean;
  linkUrl: string | null;
}

function normalizeUsername(rawUsername: string): string {
  return rawUsername.trim().replace(/^@+/, '').toLowerCase();
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeOffset(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function linkUrl(botUsername: string, code: string): string | null {
  if (!botUsername || !code) return null;
  return `https://t.me/${botUsername}?start=${code}`;
}

function hasActivePendingLink(telegram: TelegramSecrets): boolean {
  if (!telegram.pendingLinkCode) return false;
  const createdAt = Date.parse(telegram.pendingLinkCreatedAt);
  if (!Number.isFinite(createdAt)) return false;
  return Date.now() - createdAt <= TELEGRAM_LINK_TTL_MS;
}

function normalizeSnapshot(value: unknown): NotificationSecretsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySnapshot();
  const raw = value as Record<string, unknown>;
  const telegram = raw.telegram && typeof raw.telegram === 'object' && !Array.isArray(raw.telegram)
    ? raw.telegram as Record<string, unknown>
    : {};
  return {
    version: 1,
    telegram: {
      botToken: safeString(telegram.botToken),
      botId: typeof telegram.botId === 'number' && Number.isSafeInteger(telegram.botId) ? telegram.botId : null,
      botUsername: normalizeUsername(safeString(telegram.botUsername)),
      botFirstName: safeString(telegram.botFirstName),
      recipientUsername: normalizeUsername(safeString(telegram.recipientUsername)),
      recipientDisplayName: safeString(telegram.recipientDisplayName),
      chatId: safeString(telegram.chatId),
      pendingLinkCode: safeString(telegram.pendingLinkCode),
      pendingLinkCreatedAt: safeString(telegram.pendingLinkCreatedAt),
      updateOffset: safeOffset(telegram.updateOffset),
    },
  };
}

function defaultStorePath(): string {
  return path.join(getConfigDir(), 'notifications.json');
}

interface TelegramSettingsStoreEvents {
  changed: [];
}

export class TelegramSettingsStore extends EventEmitter<TelegramSettingsStoreEvents> {
  #filePath: string;
  #snapshot: NotificationSecretsSnapshot = emptySnapshot();
  #writeLock = new KeyedPromiseLock();

  constructor(filePath = defaultStorePath()) {
    super();
    this.#filePath = filePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    this.#snapshot = await this.#read();
    await this.#write(this.#snapshot);
  }

  get isConfigured(): boolean {
    return Boolean(this.#snapshot.telegram.botToken);
  }

  getBotToken(): string {
    return this.#snapshot.telegram.botToken;
  }

  getRecipientChatId(): string {
    return this.#snapshot.telegram.chatId;
  }

  getUpdateOffset(): number | null {
    return this.#snapshot.telegram.updateOffset;
  }

  getPendingLinkCode(): string {
    if (!hasActivePendingLink(this.#snapshot.telegram)) return '';
    return this.#snapshot.telegram.pendingLinkCode;
  }

  getPublicStatus(): TelegramPublicStatus {
    const telegram = this.#snapshot.telegram;
    const pendingLink = hasActivePendingLink(telegram);
    return {
      botTokenAvailable: Boolean(telegram.botToken),
      botUsername: telegram.botUsername || null,
      botFirstName: telegram.botFirstName || null,
      recipientUsername: telegram.recipientUsername || null,
      recipientDisplayName: telegram.recipientDisplayName || null,
      recipientLinked: Boolean(telegram.chatId),
      pendingLink,
      linkUrl: pendingLink ? linkUrl(telegram.botUsername, telegram.pendingLinkCode) : null,
    };
  }

  onChanged(cb: () => void): void {
    this.on('changed', cb);
  }

  async setBotToken(rawToken: string, identity: TelegramBotIdentity): Promise<void> {
    const botToken = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!botToken) throw new Error('botToken is required');
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      snapshot.telegram.botToken = botToken;
      snapshot.telegram.botId = identity.id;
      snapshot.telegram.botUsername = normalizeUsername(identity.username);
      snapshot.telegram.botFirstName = identity.firstName;
      snapshot.telegram.recipientUsername = '';
      snapshot.telegram.recipientDisplayName = '';
      snapshot.telegram.chatId = '';
      snapshot.telegram.pendingLinkCode = '';
      snapshot.telegram.pendingLinkCreatedAt = '';
      snapshot.telegram.updateOffset = null;
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    this.emit('changed');
  }

  async clearBotToken(): Promise<void> {
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      snapshot.telegram = emptySnapshot().telegram;
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    this.emit('changed');
  }

  async beginRecipientLink(): Promise<string> {
    let url: string | null = null;
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      if (!snapshot.telegram.botToken || !snapshot.telegram.botUsername) {
        throw new Error('Telegram bot token is not configured');
      }
      snapshot.telegram.pendingLinkCode = randomBytes(16).toString('hex');
      snapshot.telegram.pendingLinkCreatedAt = new Date().toISOString();
      url = linkUrl(snapshot.telegram.botUsername, snapshot.telegram.pendingLinkCode);
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    this.emit('changed');
    return url ?? '';
  }

  async completeRecipientLink(recipient: TelegramResolvedRecipient): Promise<void> {
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      snapshot.telegram.chatId = recipient.chatId;
      snapshot.telegram.recipientUsername = normalizeUsername(recipient.username ?? '');
      snapshot.telegram.recipientDisplayName = recipient.displayName ?? '';
      snapshot.telegram.pendingLinkCode = '';
      snapshot.telegram.pendingLinkCreatedAt = '';
      snapshot.telegram.updateOffset = recipient.nextOffset;
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    this.emit('changed');
  }

  async clearRecipient(): Promise<void> {
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      snapshot.telegram.recipientUsername = '';
      snapshot.telegram.recipientDisplayName = '';
      snapshot.telegram.chatId = '';
      snapshot.telegram.pendingLinkCode = '';
      snapshot.telegram.pendingLinkCreatedAt = '';
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    this.emit('changed');
  }

  async setUpdateOffset(updateOffset: number | null): Promise<void> {
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      snapshot.telegram.updateOffset = updateOffset;
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    this.emit('changed');
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.#writeLock.runExclusive(TELEGRAM_SETTINGS_WRITE_LOCK_KEY, fn);
  }

  async #read(): Promise<NotificationSecretsSnapshot> {
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      return normalizeSnapshot(JSON.parse(raw));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
      logger.warn('notifications: invalid notifications.json, using empty notification secrets:', (error as Error).message);
      return emptySnapshot();
    }
  }

  async #write(snapshot: NotificationSecretsSnapshot): Promise<void> {
    await writeJsonFileAtomic(this.#filePath, snapshot, { mode: 0o600 });
  }
}
