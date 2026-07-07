// Stores Web Push subscription endpoints per workspace. Endpoints act like
// bearer delivery addresses, so logs and public API responses use hashes.

import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import type { BrowserNotificationDisplayMode } from '../../common/ws-requests.js';

const logger = createLogger('notifications:browser-push-subscriptions');
const BROWSER_PUSH_SUBSCRIPTION_WRITE_LOCK_KEY = 'browser-push-subscriptions';

export interface BrowserPushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface BrowserPushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys?: Partial<BrowserPushSubscriptionKeys> | null;
}

export interface BrowserPushSubscriptionRecord {
  endpoint: string;
  endpointHash: string;
  expirationTime: number | null;
  keys: BrowserPushSubscriptionKeys;
  userAgent: string;
  displayMode: BrowserNotificationDisplayMode;
  platform: string;
  origin: string;
  enabled: boolean;
  clientId: string;
  createdAt: string;
  lastSeenAt: string;
}

interface BrowserPushSubscriptionSnapshot {
  version: 1;
  subscriptions: BrowserPushSubscriptionRecord[];
}

export interface BrowserPushSubscriptionUpsertInput {
  subscription: unknown;
  clientId: string;
  userAgent: string;
  displayMode: BrowserNotificationDisplayMode;
  platform: string;
  origin: string;
}

function emptySnapshot(): BrowserPushSubscriptionSnapshot {
  return {
    version: 1,
    subscriptions: [],
  };
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeExpirationTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeDisplayMode(value: unknown): BrowserNotificationDisplayMode {
  return value === 'browser' || value === 'standalone' ? value : 'unknown';
}

export function hashPushEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('base64url');
}

function normalizeOrigin(value: unknown): string {
  const origin = safeString(value).trim();
  if (!origin) return '';
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function normalizeRecord(value: unknown): BrowserPushSubscriptionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const endpoint = safeString(raw.endpoint).trim();
  const endpointHash = safeString(raw.endpointHash).trim() || (endpoint ? hashPushEndpoint(endpoint) : '');
  const keys = raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys)
    ? raw.keys as Record<string, unknown>
    : {};
  const p256dh = safeString(keys.p256dh).trim();
  const auth = safeString(keys.auth).trim();
  if (!endpoint || !endpointHash || !p256dh || !auth) return null;
  return {
    endpoint,
    endpointHash,
    expirationTime: safeExpirationTime(raw.expirationTime),
    keys: { p256dh, auth },
    userAgent: safeString(raw.userAgent),
    displayMode: safeDisplayMode(raw.displayMode),
    platform: safeString(raw.platform),
    origin: normalizeOrigin(raw.origin),
    enabled: raw.enabled !== false,
    clientId: safeString(raw.clientId),
    createdAt: safeString(raw.createdAt) || new Date().toISOString(),
    lastSeenAt: safeString(raw.lastSeenAt) || new Date().toISOString(),
  };
}

function normalizeSnapshot(value: unknown): BrowserPushSubscriptionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySnapshot();
  const raw = value as Record<string, unknown>;
  const subscriptions = Array.isArray(raw.subscriptions)
    ? raw.subscriptions.map(normalizeRecord).filter((entry): entry is BrowserPushSubscriptionRecord => Boolean(entry))
    : [];
  const byHash = new Map<string, BrowserPushSubscriptionRecord>();
  for (const subscription of subscriptions) byHash.set(subscription.endpointHash, subscription);
  return {
    version: 1,
    subscriptions: [...byHash.values()],
  };
}

function sanitizeSubscription(input: unknown): BrowserPushSubscriptionJson {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('subscription is required');
  }
  const raw = input as Record<string, unknown>;
  const endpoint = safeString(raw.endpoint).trim();
  if (!endpoint) throw new Error('subscription.endpoint is required');
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error('subscription.endpoint must be a valid URL');
  }
  if (endpointUrl.protocol !== 'https:') {
    throw new Error('subscription.endpoint must be an https URL');
  }
  const keys = raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys)
    ? raw.keys as Record<string, unknown>
    : {};
  const p256dh = safeString(keys.p256dh).trim();
  const auth = safeString(keys.auth).trim();
  if (!p256dh || !auth) throw new Error('subscription.keys.p256dh and subscription.keys.auth are required');
  return {
    endpoint,
    expirationTime: safeExpirationTime(raw.expirationTime),
    keys: { p256dh, auth },
  };
}

function defaultStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, 'browser-push-subscriptions.json');
}

export class BrowserPushSubscriptionStore extends EventEmitter {
  #filePath: string;
  #snapshot: BrowserPushSubscriptionSnapshot = emptySnapshot();
  #writeLock = new KeyedPromiseLock();

  constructor(workspaceDirOrFilePath: string, options: { filePath?: boolean } = {}) {
    super();
    this.#filePath = options.filePath ? workspaceDirOrFilePath : defaultStorePath(workspaceDirOrFilePath);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    this.#snapshot = await this.#read();
    await this.#write(this.#snapshot);
  }

  countEnabled(): number {
    return this.#snapshot.subscriptions.filter((entry) => entry.enabled).length;
  }

  listEnabled(): BrowserPushSubscriptionRecord[] {
    return this.#snapshot.subscriptions
      .filter((entry) => entry.enabled)
      .map((entry) => ({ ...entry, keys: { ...entry.keys } }));
  }

  onChanged(cb: () => void): void {
    this.on('changed', cb);
  }

  async upsert(input: BrowserPushSubscriptionUpsertInput): Promise<BrowserPushSubscriptionRecord> {
    const subscription = sanitizeSubscription(input.subscription);
    const endpointHash = hashPushEndpoint(subscription.endpoint);
    const now = new Date().toISOString();
    const clientId = safeString(input.clientId).trim();
    if (!clientId) throw new Error('clientId is required');
    const origin = normalizeOrigin(input.origin);
    if (!origin) throw new Error('origin is required');

    let saved: BrowserPushSubscriptionRecord | null = null;
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      const existing = snapshot.subscriptions.find((entry) => entry.endpointHash === endpointHash);
      saved = {
        endpoint: subscription.endpoint,
        endpointHash,
        expirationTime: subscription.expirationTime ?? null,
        keys: subscription.keys as BrowserPushSubscriptionKeys,
        userAgent: safeString(input.userAgent),
        displayMode: safeDisplayMode(input.displayMode),
        platform: safeString(input.platform),
        origin,
        enabled: true,
        clientId,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
      };
      snapshot.subscriptions = [
        ...snapshot.subscriptions.filter((entry) => entry.endpointHash !== endpointHash),
        saved,
      ];
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    logger.info(`browser-push: subscription upserted ${endpointHash}`);
    this.emit('changed');
    return saved!;
  }

  async removeByEndpointHash(endpointHash: string): Promise<boolean> {
    const normalizedHash = safeString(endpointHash).trim();
    if (!normalizedHash) return false;
    let removed = false;
    await this.#withLock(async () => {
      const snapshot = await this.#read();
      const nextSubscriptions = snapshot.subscriptions.filter((entry) => entry.endpointHash !== normalizedHash);
      removed = nextSubscriptions.length !== snapshot.subscriptions.length;
      if (!removed) return;
      snapshot.subscriptions = nextSubscriptions;
      this.#snapshot = snapshot;
      await this.#write(snapshot);
    });
    if (removed) {
      logger.info(`browser-push: subscription removed ${normalizedHash}`);
      this.emit('changed');
    }
    return removed;
  }

  async removeByEndpoint(endpoint: string): Promise<boolean> {
    const normalizedEndpoint = safeString(endpoint).trim();
    if (!normalizedEndpoint) return false;
    return this.removeByEndpointHash(hashPushEndpoint(normalizedEndpoint));
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.#writeLock.runExclusive(BROWSER_PUSH_SUBSCRIPTION_WRITE_LOCK_KEY, fn);
  }

  async #read(): Promise<BrowserPushSubscriptionSnapshot> {
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      return normalizeSnapshot(JSON.parse(raw));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
      logger.warn('notifications: invalid browser-push-subscriptions.json, using empty subscriptions:', (error as Error).message);
      return emptySnapshot();
    }
  }

  async #write(snapshot: BrowserPushSubscriptionSnapshot): Promise<void> {
    await writeJsonFileAtomic(this.#filePath, snapshot, { mode: 0o600 });
  }
}
