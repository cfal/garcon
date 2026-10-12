import { afterEach, expect, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import jwt from 'jsonwebtoken';
import { authFixture, fixturePasswords } from './fixture.js';
import { AuthAccountStore } from '../store.js';
import { AuthService } from '../service.js';
import { AUTH_SESSION_LIMIT } from '../sessions.js';
import { AtomicJsonWriteError, CorruptStateFileError, writeJsonFileAtomic } from '../../../common/json-file-store.js';

const fixtures = [];
async function fixture(options) { const f = await authFixture(options); fixtures.push(f); return f; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())); });
const identity = token => {
  const claims = jwt.decode(token);
  return { ownerKey: claims.sub, sessionId: claims.sid, expiresAtMs: claims.exp * 1000 };
};
const active = (store, session) => store.isSessionCurrent(session.ownerKey, session.sessionId, session.expiresAtMs);

test('each login has a unique durable session; revocation survives restart without affecting others', async () => {
  const f = await fixture();
  const first = identity((await f.register()).token);
  const second = identity((await f.service.login({ username: 'owner-before', password: 'password-before' })).token);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect((await stat(f.store.sessionsFilePath)).mode & 0o777).toBe(0o600);
  expect(active(f.store, first)).toBe(true);
  await f.store.revokeSession(first.ownerKey, first.sessionId);
  expect(active(f.store, first)).toBe(false);
  expect(active(f.store, second)).toBe(true);
  const restarted = new AuthAccountStore(f.filePath);
  await restarted.initialize();
  expect(active(restarted, first)).toBe(false);
  expect(active(restarted, second)).toBe(true);
  await restarted.revokeSession(first.ownerKey, first.sessionId);
  expect(JSON.parse(await readFile(f.store.sessionsFilePath, 'utf8')).sessions).toHaveLength(1);
});

test('credential changes retain the session and deadline so old proofs revoke delayed replacements', async () => {
  const f = await fixture();
  const first = identity((await f.register()).token);
  const replacement = await f.service.changeUsername(await f.principal(), async () => ({ currentPassword: 'password-before', username: 'next-owner' }));
  expect(identity(replacement.token)).toEqual(first);
  expect(jwt.decode(replacement.token).credentialRevision).toBe(2);
  await f.store.revokeSession(first.ownerKey, first.sessionId);
  expect(active(f.store, identity(replacement.token))).toBe(false);
});

test('logout during password verification prevents a credential commit', async () => {
  const f = await fixture();
  const first = identity((await f.register()).token);
  const principal = await f.principal();
  const started = Promise.withResolvers();
  const verified = Promise.withResolvers();
  f.passwords.verify = () => { started.resolve(); return verified.promise; };
  const change = f.service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'next-owner' }));
  await started.promise;
  await f.store.revokeSession(first.ownerKey, first.sessionId);
  verified.resolve(true);
  await expect(change).rejects.toMatchObject({ code: 'AUTH_SESSION_INVALID' });
  expect((await f.store.snapshot()).account.credentialRevision).toBe(1);
});

test('logout queues behind an admitted credential commit and revokes its replacement', async () => {
  const writing = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pause = false;
  const f = await fixture({ write: async (...args) => {
    if (pause && args[0].endsWith('/auth.json')) { writing.resolve(); await release.promise; }
    await writeJsonFileAtomic(...args);
  } });
  const first = identity((await f.register()).token);
  const principal = await f.principal();
  pause = true;
  const change = f.service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'next-owner' }));
  await writing.promise;
  const logout = f.store.revokeSession(first.ownerKey, first.sessionId);
  release.resolve();
  const changed = await change;
  await logout;
  expect(active(f.store, identity(changed.token))).toBe(false);
});

test.each([false, true])('registry failures preserve definite versus uncertain logout: renamed=%s', async renamed => {
  let fail = false;
  const f = await fixture({ write: async (...args) => {
    if (!fail || !args[0].endsWith('/auth-sessions.json')) return writeJsonFileAtomic(...args);
    if (renamed) await writeJsonFileAtomic(...args);
    throw new AtomicJsonWriteError('Synthetic registry failure', renamed);
  } });
  const first = identity((await f.register()).token);
  fail = true;
  const changes = [];
  f.store.onChange(change => changes.push(change));
  await expect(f.store.revokeSession(first.ownerKey, first.sessionId)).rejects.toMatchObject({
    code: renamed ? 'AUTH_STORAGE_UNAVAILABLE' : 'AUTH_SAVE_FAILED',
  });
  expect(active(f.store, first)).toBe(!renamed);
  expect(changes).toEqual(renamed ? ['storage-unavailable'] : []);
  const restarted = new AuthAccountStore(f.filePath);
  await restarted.initialize();
  expect(active(restarted, first)).toBe(!renamed);
});

test('corrupt registries remain fail-closed after quarantine and restart', async () => {
  const f = await fixture();
  await f.register();
  await writeFile(f.store.sessionsFilePath, JSON.stringify({ version: 1, sessions: [{ sessionId: 'bad', expiresAtMs: 1 }] }));
  await expect(new AuthAccountStore(f.filePath).initialize()).rejects.toBeInstanceOf(CorruptStateFileError);
  await expect(new AuthAccountStore(f.filePath).initialize()).rejects.toBeInstanceOf(CorruptStateFileError);
});

test('repeated logout needs no write even when unrelated registry rows have expired', async () => {
  const f = await fixture();
  await f.register();
  await writeFile(f.store.sessionsFilePath, JSON.stringify({ version: 1, sessions: [
    { sessionId: 'b'.repeat(64), ownerKey: 'owner-before', expiresAtMs: 1 },
  ] }));
  const restarted = new AuthAccountStore(f.filePath, async () => { throw new Error('Writer must not run'); });
  await restarted.initialize();
  await expect(restarted.revokeSession('owner-before', 'a'.repeat(64))).resolves.toBeUndefined();
});

test('registry admission prunes expired sessions and never evicts unrelated live sessions', async () => {
  const f = await fixture();
  await f.register();
  const sessions = Array.from({ length: AUTH_SESSION_LIMIT }, (_, index) => ({
    sessionId: index.toString(16).padStart(64, '0'), ownerKey: 'owner-before', expiresAtMs: Date.now() + 60_000,
  }));
  await writeFile(f.store.sessionsFilePath, JSON.stringify({ version: 1, sessions }));
  const full = new AuthService(new AuthAccountStore(f.filePath), fixturePasswords);
  await expect(full.login({ username: 'owner-before', password: 'password-before' })).rejects.toMatchObject({ code: 'AUTH_BUSY' });
  sessions[0].expiresAtMs = 1;
  await writeFile(f.store.sessionsFilePath, JSON.stringify({ version: 1, sessions }));
  const pruned = new AuthService(new AuthAccountStore(f.filePath), fixturePasswords);
  await pruned.login({ username: 'owner-before', password: 'password-before' });
  const stored = JSON.parse(await readFile(f.store.sessionsFilePath, 'utf8')).sessions;
  expect(stored).toHaveLength(AUTH_SESSION_LIMIT);
  expect(stored.slice(0, -1)).toEqual(sessions.slice(1));
});
