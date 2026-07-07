// Persists VAPID keys used to identify this Garcon server to Web Push
// services. The private key never crosses the HTTP API boundary.

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import webpush from 'web-push';
import { getConfigDir } from '../config.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('notifications:browser-push-settings');
const BROWSER_PUSH_SETTINGS_WRITE_LOCK_KEY = 'browser-push-settings';
const DEFAULT_VAPID_SUBJECT = 'mailto:notifications@garcon.local';
const VAPID_PUBLIC_KEY_BYTES = 65;
const VAPID_PRIVATE_KEY_BYTES = 32;
const VAPID_PUBLIC_KEY_PREFIX = 4;

export interface BrowserPushVapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface BrowserPushSettingsSnapshot {
  version: 1;
  vapid: BrowserPushVapidKeys;
}

function emptySnapshot(): BrowserPushSettingsSnapshot {
  return {
    version: 1,
    vapid: {
      publicKey: '',
      privateKey: '',
      subject: resolveVapidSubject(),
    },
  };
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function resolveVapidSubject(): string {
  const subject = process.env.GARCON_VAPID_SUBJECT?.trim();
  return subject || DEFAULT_VAPID_SUBJECT;
}

function decodeBase64Url(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) return null;
  try {
    const padding = '='.repeat((4 - (trimmed.length % 4)) % 4);
    return Buffer.from((trimmed + padding).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

function isValidVapidPublicKey(value: string): boolean {
  const decoded = decodeBase64Url(value);
  return decoded !== null
    && decoded.length === VAPID_PUBLIC_KEY_BYTES
    && decoded[0] === VAPID_PUBLIC_KEY_PREFIX;
}

function isValidVapidPrivateKey(value: string): boolean {
  const decoded = decodeBase64Url(value);
  return decoded !== null && decoded.length === VAPID_PRIVATE_KEY_BYTES;
}

function hasValidVapidKeys(keys: BrowserPushVapidKeys): boolean {
  return isValidVapidPublicKey(keys.publicKey) && isValidVapidPrivateKey(keys.privateKey);
}

function normalizeSnapshot(value: unknown): BrowserPushSettingsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySnapshot();
  const raw = value as Record<string, unknown>;
  const vapid = raw.vapid && typeof raw.vapid === 'object' && !Array.isArray(raw.vapid)
    ? raw.vapid as Record<string, unknown>
    : {};
  return {
    version: 1,
    vapid: {
      publicKey: safeString(vapid.publicKey),
      privateKey: safeString(vapid.privateKey),
      subject: safeString(vapid.subject) || resolveVapidSubject(),
    },
  };
}

function createVapidKeys(subject = resolveVapidSubject()): BrowserPushVapidKeys {
  const keys = webpush.generateVAPIDKeys();
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject,
  };
}

function defaultStorePath(): string {
  return path.join(getConfigDir(), 'browser-push-vapid.json');
}

export class BrowserPushSettingsStore extends EventEmitter {
  #filePath: string;
  #snapshot: BrowserPushSettingsSnapshot = emptySnapshot();
  #writeLock = new KeyedPromiseLock();

  constructor(filePath = defaultStorePath()) {
    super();
    this.#filePath = filePath;
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    this.#snapshot = await this.#read();
    if (!hasValidVapidKeys(this.#snapshot.vapid)) {
      if (this.#snapshot.vapid.publicKey || this.#snapshot.vapid.privateKey) {
        logger.warn('notifications: invalid browser push VAPID key format, regenerating keys');
      }
      this.#snapshot.vapid = createVapidKeys(this.#snapshot.vapid.subject);
    }
    await this.#write(this.#snapshot);
  }

  get isConfigured(): boolean {
    return hasValidVapidKeys(this.#snapshot.vapid);
  }

  getPublicKey(): string {
    return this.#snapshot.vapid.publicKey;
  }

  getVapidKeys(): BrowserPushVapidKeys {
    return { ...this.#snapshot.vapid };
  }

  onChanged(cb: () => void): void {
    this.on('changed', cb);
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.#writeLock.runExclusive(BROWSER_PUSH_SETTINGS_WRITE_LOCK_KEY, fn);
  }

  async #read(): Promise<BrowserPushSettingsSnapshot> {
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      return normalizeSnapshot(JSON.parse(raw));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
      logger.warn('notifications: invalid browser-push-vapid.json, regenerating missing keys:', (error as Error).message);
      return emptySnapshot();
    }
  }

  async #write(snapshot: BrowserPushSettingsSnapshot): Promise<void> {
    await this.#withLock(async () => {
      await writeJsonFileAtomic(this.#filePath, snapshot, { mode: 0o600 });
    });
  }
}
