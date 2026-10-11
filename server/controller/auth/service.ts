import {
  parseChangePasswordRequest, parseChangeUsernameRequest, parseLoginRequest, parseRegisterRequest,
  type AuthSessionResponse,
} from '../../../common/auth.js';
import { DomainError } from '../../common/domain-error.js';
import { AuthAccountAlreadyConfiguredError, AuthSnapshotChangedError, getAuthStore,
  type AuthAccount, type AuthAccountStore, type AuthSnapshot } from './store.js';
import { signAuthSnapshot, prepareAuthSession } from './token.js';
import type { ServerPrincipal } from '../lib/http-route-types.js';
import { createLogger } from '../../common/log.js';

const logger = createLogger('auth:service');

interface Passwords {
  verify(password: string, hash: string): Promise<boolean>;
  hash(password: string): Promise<string>;
}
const defaultPasswords: Passwords = {
  verify: (password, hash) => Bun.password.verify(password, hash),
  hash: password => Bun.password.hash(password, { algorithm: 'bcrypt', cost: 12 }),
};

function sessionResponse(snapshot: AuthSnapshot, token: string): AuthSessionResponse {
  if (!snapshot.account) throw new Error('Account is not configured');
  return {
    success: true,
    user: { id: snapshot.account.ownerKey, username: snapshot.account.username },
    token,
  };
}

function newSession(snapshot: AuthSnapshot) {
  const { session, token } = prepareAuthSession(snapshot);
  return { session, result: sessionResponse(snapshot, token) };
}

export class AuthService {
  #active = 0;
  #changing = false;
  #changes: number[] = [];

  constructor(readonly store: AuthAccountStore, private readonly passwords: Passwords = defaultPasswords) {}

  async login(value: unknown, signal?: AbortSignal): Promise<AuthSessionResponse> {
    const input = parseLoginRequest(value);
    return this.#admit(async () => {
      const snapshot = await this.store.snapshot();
      const account = snapshot.account;
      if (!account || input.username !== account.username || !await this.passwords.verify(input.password, account.passwordHash)) {
        this.store.assertHealthy();
        throw this.#invalidLogin();
      }
      try {
        return await this.store.openSession(snapshot, () => {
          signal?.throwIfAborted();
          return newSession(snapshot);
        });
      } catch (error) { if (error instanceof AuthSnapshotChangedError) throw this.#invalidLogin(); throw error; }
    });
  }

  async register(value: unknown, signal?: AbortSignal): Promise<AuthSessionResponse> {
    const input = parseRegisterRequest(value);
    return this.#admit(async () => {
      const snapshot = await this.store.snapshot();
      if (snapshot.account) throw new AuthAccountAlreadyConfiguredError();
      const passwordHash = await this.passwords.hash(input.password);
      try {
        return await this.store.register(snapshot, () => {
          signal?.throwIfAborted();
          const account: AuthAccount = { ownerKey: input.username, username: input.username, credentialRevision: 1,
            passwordHash, createdAt: new Date().toISOString() };
          return { account, ...newSession({ ...snapshot, account }) };
        });
      } catch (error) {
        if (error instanceof AuthSnapshotChangedError) throw new AuthAccountAlreadyConfiguredError();
        throw error;
      }
    });
  }

  changeUsername(principal: ServerPrincipal, read: () => Promise<unknown>, signal?: AbortSignal): Promise<AuthSessionResponse> {
    return this.#change('username', principal, async () => {
      const input = parseChangeUsernameRequest(await read());
      return { currentPassword: input.currentPassword, replace: async (account: AuthAccount) => {
        if (input.username === account.username) throw new DomainError('AUTH_NO_CHANGE', 'Username is unchanged.');
        return { ...account, username: input.username };
      } };
    }, signal);
  }

  changePassword(principal: ServerPrincipal, read: () => Promise<unknown>, signal?: AbortSignal): Promise<AuthSessionResponse> {
    return this.#change('password', principal, async () => {
      const input = parseChangePasswordRequest(await read());
      return { currentPassword: input.currentPassword, replace: async (account: AuthAccount) => {
        if (input.newPassword === input.currentPassword) throw new DomainError('AUTH_NO_CHANGE', 'Password is unchanged.');
        return { ...account, passwordHash: await this.passwords.hash(input.newPassword) };
      } };
    }, signal);
  }

  async #change(operation: 'username' | 'password', principal: ServerPrincipal, prepare: () => Promise<{
    currentPassword: string; replace: (account: AuthAccount) => Promise<AuthAccount>;
  }>, signal?: AbortSignal): Promise<AuthSessionResponse> {
    if (principal.mode !== 'authenticated') throw new DomainError('AUTH_CHANGE_FORBIDDEN', 'Sign in to change credentials.', 403);
    this.store.assertHealthy();
    const now = Date.now();
    this.#changes = this.#changes.filter(at => at > now - 60_000);
    if (this.#changing || this.#changes.length >= 10) throw this.#busy();
    this.#changes.push(now);
    this.#changing = true;
    try {
      const { currentPassword, replace } = await prepare();
      return await this.#admit(async () => {
        const snapshot = await this.store.snapshot();
        this.#assertPrincipal(principal, snapshot);
        if (!await this.passwords.verify(currentPassword, snapshot.account!.passwordHash)) {
          throw new DomainError('AUTH_CURRENT_PASSWORD_INVALID', 'Current password is incorrect.');
        }
        signal?.throwIfAborted();
        const updated = await replace(snapshot.account!);
        if (updated.credentialRevision === Number.MAX_SAFE_INTEGER) {
          throw new DomainError('AUTH_REVISION_EXHAUSTED', 'Credential revision is exhausted.', 409);
        }
        try {
          const result = await this.store.commit(snapshot, () => {
            this.#assertPrincipal(principal, snapshot);
            signal?.throwIfAborted();
            const account = { ...updated, credentialRevision: updated.credentialRevision + 1 };
            const replacement = { ...snapshot, account };
            const token = signAuthSnapshot(replacement, {
              sessionId: principal.sessionId, ownerKey: principal.key, expiresAtMs: principal.expiresAtMs,
            });
            return { account, result: sessionResponse(replacement, token) };
          });
          logger.info('Account credentials changed', { operation, previousRevision: updated.credentialRevision,
            credentialRevision: updated.credentialRevision + 1 });
          return result;
        } catch (error) {
          if (error instanceof AuthSnapshotChangedError) throw new DomainError('AUTH_SESSION_INVALID', 'Sign in again.', 401);
          throw error;
        }
      });
    } finally { this.#changing = false; }
  }

  #assertPrincipal(principal: Extract<ServerPrincipal, { mode: 'authenticated' }>, snapshot: AuthSnapshot): void {
    if (!snapshot.account || principal.expiresAtMs <= Date.now() || principal.key !== snapshot.account.ownerKey
      || principal.credentialRevision !== snapshot.account.credentialRevision
      || !this.store.isSessionCurrent(principal.key, principal.sessionId, principal.expiresAtMs)) {
      throw new DomainError('AUTH_SESSION_INVALID', 'Sign in again.', 401);
    }
  }

  async #admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= 2) throw this.#busy();
    this.#active++;
    try { return await operation(); } finally { this.#active--; }
  }

  #invalidLogin(): DomainError { return new DomainError('AUTH_CREDENTIALS_INVALID', 'Invalid username or password', 401); }
  #busy(): DomainError { return new DomainError('AUTH_BUSY', 'Authentication is busy. Try again shortly.', 429); }
}

const services = new WeakMap<AuthAccountStore, AuthService>();
export function getAuthService(): AuthService {
  const store = getAuthStore();
  let service = services.get(store);
  if (!service) { service = new AuthService(store); services.set(store, service); }
  return service;
}
