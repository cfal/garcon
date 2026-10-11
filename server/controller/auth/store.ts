import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isRecord } from '../../../common/json.js';
import { getConfigDir } from '../config.js';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../../common/json-file-store.js';
import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import { DomainError } from '../../common/domain-error.js';
import { createLogger } from '../../common/log.js';
import { AUTH_SESSION_LIMIT, parseStoredSessions, type AuthBrowserSession } from './sessions.js';

export interface AuthAccount {
  readonly ownerKey: string;
  readonly credentialRevision: number;
  readonly username: string;
  readonly passwordHash: string;
  readonly createdAt: string | null;
}

export interface AuthSnapshot {
  readonly jwtSecret: string;
  readonly account: AuthAccount | null;
}

export type AuthChange = 'credentials' | 'sessions' | 'storage-unavailable';
export class AuthSnapshotChangedError extends Error {}
export class AuthAccountAlreadyConfiguredError extends DomainError {
  constructor() { super('VALIDATION_FAILED', 'Account already configured', 409); }
}

const logger = createLogger('auth:store');
type Writer = typeof writeJsonFileAtomic;

function parseStoredAuth(value: unknown): { snapshot: AuthSnapshot; initialize: boolean } {
  if (!isRecord(value)) throw new Error('Auth state must be an object');
  const fields = ['jwtSecret', 'username', 'passwordHash', 'createdAt', 'ownerKey', 'credentialRevision'];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('Unknown auth state fields');
  const hasAccount = ['username', 'passwordHash', 'createdAt', 'ownerKey', 'credentialRevision']
    .some(key => Object.hasOwn(value, key));
  if (Object.hasOwn(value, 'jwtSecret') && (typeof value.jwtSecret !== 'string' || !value.jwtSecret)) {
    throw new Error('Invalid auth secret');
  }
  if (!hasAccount) {
    const secret = typeof value.jwtSecret === 'string' ? value.jwtSecret : randomBytes(32).toString('hex');
    return { snapshot: Object.freeze({ jwtSecret: secret, account: null }), initialize: !value.jwtSecret };
  }
  if (typeof value.jwtSecret !== 'string' || !value.jwtSecret
    || typeof value.username !== 'string' || !value.username
    || typeof value.passwordHash !== 'string' || !value.passwordHash
    || value.createdAt !== undefined && value.createdAt !== null && typeof value.createdAt !== 'string') {
    throw new Error('Incomplete auth account');
  }
  const initialize = !Object.hasOwn(value, 'ownerKey') && !Object.hasOwn(value, 'credentialRevision');
  const ownerKey = initialize ? value.username : value.ownerKey;
  const credentialRevision = initialize ? 1 : value.credentialRevision;
  if (typeof ownerKey !== 'string' || !ownerKey || typeof credentialRevision !== 'number'
    || !Number.isSafeInteger(credentialRevision) || credentialRevision < 1) throw new Error('Invalid auth identity');
  const account: AuthAccount = Object.freeze({
    ownerKey, credentialRevision, username: value.username, passwordHash: value.passwordHash,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
  });
  return { snapshot: Object.freeze({ jwtSecret: value.jwtSecret, account }), initialize };
}

function serialized(snapshot: AuthSnapshot) {
  return { jwtSecret: snapshot.jwtSecret, ...snapshot.account };
}

export class AuthAccountStore {
  readonly #lock = new KeyedPromiseLock();
  readonly #listeners = new Set<(change: AuthChange) => void>();
  #snapshot: AuthSnapshot | null = null;
  #initializing: Promise<void> | null = null;
  #unavailable = false;
  #sessions: readonly AuthBrowserSession[] = [];
  readonly sessionsFilePath: string;

  constructor(readonly filePath: string, private readonly write: Writer = writeJsonFileAtomic) {
    this.sessionsFilePath = path.join(path.dirname(filePath), 'auth-sessions.json');
  }

  initialize(): Promise<void> {
    return this.#initializing ??= this.#lock.runExclusive(this.filePath, async () => {
      const parsed = await readJsonStateFile({ filePath: this.filePath, empty: () => parseStoredAuth({}), normalize: parseStoredAuth });
      this.#sessions = await readJsonStateFile({ filePath: this.sessionsFilePath,
        empty: () => [], normalize: parseStoredSessions });
      if (parsed.initialize) await this.#persist(parsed.snapshot);
      this.#snapshot = parsed.snapshot;
    });
  }

  async snapshot(): Promise<AuthSnapshot> {
    await this.initialize();
    this.assertHealthy();
    return this.#snapshot!;
  }

  assertHealthy(): void {
    if (this.#unavailable) throw new DomainError('AUTH_STORAGE_UNAVAILABLE',
      'Credential durability is unknown. Resolve storage and restart the controller.', 503);
  }

  get isUnavailable(): boolean { return this.#unavailable; }

  isCurrent(ownerKey: string, revision: number): boolean {
    const account = this.#snapshot?.account;
    return !this.#unavailable && !!account && account.ownerKey === ownerKey && account.credentialRevision === revision;
  }

  isSessionCurrent(ownerKey: string, sessionId: string, expiresAtMs: number): boolean {
    return !this.#unavailable && expiresAtMs > Date.now() && this.#sessions.some(session =>
      session.sessionId === sessionId && session.ownerKey === ownerKey && session.expiresAtMs === expiresAtMs);
  }

  onChange(listener: (change: AuthChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  openSession<T>(expected: AuthSnapshot, prepare: () => { session: AuthBrowserSession; result: T }): Promise<T> {
    return this.#lock.runExclusive(this.filePath, async () => {
      this.#assertSnapshot(expected);
      const { session, result } = prepare();
      await this.#addSession(session);
      return result;
    });
  }

  register<T>(expected: AuthSnapshot, prepare: () => { account: AuthAccount; session: AuthBrowserSession; result: T }): Promise<T> {
    return this.#lock.runExclusive(this.filePath, async () => {
      this.#assertSnapshot(expected);
      const { account, session, result } = prepare();
      const candidate = Object.freeze({ jwtSecret: expected.jwtSecret, account: Object.freeze(account) });
      // A failed account write may leave a bounded, unissued session, never an issued token.
      await this.#addSession(session);
      await this.#persist(candidate);
      this.#snapshot = candidate;
      this.#publish('credentials');
      return result;
    });
  }

  revokeSession(ownerKey: string, sessionId: string): Promise<void> {
    return this.#lock.runExclusive(this.filePath, async () => {
      this.assertHealthy();
      if (this.#snapshot?.account?.ownerKey !== ownerKey) {
        throw new DomainError('AUTH_SESSION_INVALID', 'Invalid session.', 401);
      }
      if (!this.#sessions.some(session => session.sessionId === sessionId)) return;
      const candidate = this.#sessions.filter(session => session.sessionId !== sessionId && session.expiresAtMs > Date.now());
      await this.#persistSessions(candidate);
      this.#sessions = candidate;
      this.#publish('sessions');
    });
  }

  async #addSession(session: AuthBrowserSession): Promise<void> {
    const candidate = this.#sessions.filter(entry => entry.expiresAtMs > Date.now());
    if (candidate.length >= AUTH_SESSION_LIMIT) throw new DomainError('AUTH_BUSY', 'Too many active browser sessions. Log out an existing session or wait for it to expire.', 429);
    if (candidate.some(entry => entry.sessionId === session.sessionId)) throw new Error('Duplicate auth session');
    candidate.push(Object.freeze(session));
    await this.#persistSessions(candidate);
    this.#sessions = Object.freeze(candidate);
  }

  async #persistSessions(candidate: readonly AuthBrowserSession[]): Promise<void> {
    try { await this.write(this.sessionsFilePath, { version: 1, sessions: candidate }, { mode: 0o600 }); }
    catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        this.#sessions = candidate;
        this.#unavailable = true;
        this.#publish('storage-unavailable');
        logger.error('Session write durability is unknown; browser authentication fenced.');
        this.assertHealthy();
      }
      throw new DomainError('AUTH_SAVE_FAILED', 'The session change could not be saved.', 500);
    }
  }

  commit<T>(expected: AuthSnapshot, prepare: () => { account: AuthAccount; result: T }): Promise<T> {
    return this.#lock.runExclusive(this.filePath, async () => {
      this.#assertSnapshot(expected);
      const { account, result } = prepare();
      const candidate = Object.freeze({ jwtSecret: expected.jwtSecret, account: Object.freeze(account) });
      await this.#persist(candidate);
      this.#snapshot = candidate;
      this.#publish('credentials');
      return result;
    });
  }

  #assertSnapshot(expected: AuthSnapshot): void {
    this.assertHealthy();
    if (this.#snapshot !== expected) throw new AuthSnapshotChangedError('Credentials changed');
  }

  async #persist(candidate: AuthSnapshot): Promise<void> {
    try { await this.write(this.filePath, serialized(candidate), { mode: 0o600 }); }
    catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) {
        this.#snapshot = candidate;
        this.#unavailable = true;
        this.#publish('storage-unavailable');
        logger.error('Auth write durability is unknown; browser authentication fenced.');
        this.assertHealthy();
      }
      logger.error('Auth write failed before publication.');
      throw new DomainError('AUTH_SAVE_FAILED', 'Credentials were not changed.', 500);
    }
  }

  #publish(change: AuthChange): void {
    for (const listener of this.#listeners) {
      try { listener(change); }
      catch { logger.error('Browser authorization cleanup failed.'); }
    }
  }
}

const stores = new Map<string, AuthAccountStore>();
export function getAuthStore(): AuthAccountStore {
  const filePath = path.join(getConfigDir(), 'auth.json');
  let store = stores.get(filePath);
  if (!store) { store = new AuthAccountStore(filePath); stores.set(filePath, store); }
  return store;
}

export async function init(): Promise<void> { await getAuthStore().initialize(); }
export async function needsSetup(): Promise<boolean> { return (await getAuthStore().snapshot()).account === null; }
