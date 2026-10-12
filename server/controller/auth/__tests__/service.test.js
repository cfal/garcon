import { afterEach, expect, test } from 'bun:test';
import jwt from 'jsonwebtoken';
import { authFixture, fixturePasswords } from './fixture.js';
import { AtomicJsonWriteError, writeJsonFileAtomic } from '../../../common/json-file-store.js';

const fixtures = [];
async function fixture(options) { const value = await authFixture(options); fixtures.push(value); return value; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(value => value.dispose())); });

test('separate changes preserve owner and atomically issue the next revision', async () => {
  const f = await fixture();
  const registered = await f.register();
  const renamed = await f.service.changeUsername(await f.principal(), async () => ({ currentPassword: 'password-before', username: ' owner-after ' }));
  const changed = await f.service.changePassword(await f.principal(), async () => ({ currentPassword: 'password-before', newPassword: 'password-after' }));
  expect([registered, renamed, changed].map(value => jwt.decode(value.token).credentialRevision)).toEqual([1, 2, 3]);
  expect(changed.user).toEqual({ id: 'owner-before', username: 'owner-after' });
  await expect(f.service.login({ username: 'owner-before', password: 'password-before' })).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
  await expect(f.service.login({ username: 'owner-after', password: 'password-before' })).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
  expect((await f.service.login({ username: 'owner-after', password: 'password-after' })).user).toEqual(changed.user);
});

test('wrong password, no-op, local principal and expired sessions cannot commit', async () => {
  const f = await fixture();
  await f.register();
  const principal = await f.principal();
  await expect(f.service.changeUsername(principal, async () => ({ currentPassword: 'incorrect', username: 'next' }))).rejects.toMatchObject({ code: 'AUTH_CURRENT_PASSWORD_INVALID', status: 400 });
  await expect(f.service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'owner-before' }))).rejects.toMatchObject({ code: 'AUTH_NO_CHANGE' });
  await expect(f.service.changePassword(principal, async () => ({ currentPassword: 'password-before', newPassword: 'password-before' }))).rejects.toMatchObject({ code: 'AUTH_NO_CHANGE' });
  await expect(f.service.changeUsername({ mode: 'local' }, async () => ({ currentPassword: 'password-before', username: 'next' }))).rejects.toMatchObject({ code: 'AUTH_CHANGE_FORBIDDEN' });
  await expect(f.service.changeUsername({ ...principal, expiresAtMs: 0 }, async () => ({ currentPassword: 'password-before', username: 'next' }))).rejects.toMatchObject({ code: 'AUTH_SESSION_INVALID' });
  expect((await f.store.snapshot()).account.credentialRevision).toBe(1);
});

test('login verification straddling a commit cannot sign the new revision', async () => {
  const verified = Promise.withResolvers();
  const started = Promise.withResolvers();
  const f = await fixture();
  await f.register();
  let pause = true;
  f.passwords.verify = async (...args) => {
    if (pause) { pause = false; started.resolve(); return verified.promise; }
    return fixturePasswords.verify(...args);
  };
  const login = f.service.login({ username: 'owner-before', password: 'password-before' });
  await started.promise;
  await f.service.changePassword(await f.principal(), async () => ({ currentPassword: 'password-before', newPassword: 'password-after' }));
  verified.resolve(true);
  await expect(login).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS_INVALID' });
});

test('failed login verification preserves a concurrent storage fence', async () => {
  const verified = Promise.withResolvers();
  const started = Promise.withResolvers();
  let failAfterRename = false;
  const f = await fixture({ write: async (...args) => {
    await writeJsonFileAtomic(...args);
    if (failAfterRename) throw new AtomicJsonWriteError('Synthetic durability failure', true);
  } });
  await f.register();
  const principal = await f.principal();
  let pause = true;
  f.passwords.verify = async (...args) => {
    if (pause) { pause = false; started.resolve(); return verified.promise; }
    return fixturePasswords.verify(...args);
  };
  const login = f.service.login({ username: 'owner-before', password: 'incorrect-password' }).catch(error => error);
  try {
    await started.promise;
    failAfterRename = true;
    await expect(f.service.changePassword(principal, async () => ({ currentPassword: 'password-before', newPassword: 'password-after' })))
      .rejects.toMatchObject({ code: 'AUTH_STORAGE_UNAVAILABLE', status: 503 });
    expect(f.store.isUnavailable).toBe(true);
  } finally {
    verified.resolve(false);
  }
  expect(await login).toMatchObject({ code: 'AUTH_STORAGE_UNAVAILABLE', status: 503 });
});

test('cancelled verification retains admission until actual settlement', async () => {
  const verify = Promise.withResolvers();
  const f = await fixture({ passwords: { verify: () => verify.promise } });
  await f.register();
  const abort = new AbortController();
  const first = f.service.login({ username: 'owner-before', password: 'password-before' }, abort.signal);
  const second = f.service.login({ username: 'owner-before', password: 'password-before' });
  abort.abort();
  await expect(f.service.login({ username: 'owner-before', password: 'password-before' })).rejects.toMatchObject({ code: 'AUTH_BUSY' });
  verify.resolve(true);
  await expect(first).rejects.toBeDefined();
  await second;
});

test('cancellation after persistence begins still publishes and retires authority', async () => {
  const writing = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let pause = false;
  const f = await fixture({ write: async (...args) => {
    if (pause) { writing.resolve(); await finish.promise; }
    return writeJsonFileAtomic(...args);
  } });
  await f.register();
  const principal = await f.principal();
  const abort = new AbortController();
  const changes = [];
  f.store.onChange(change => changes.push(change));
  pause = true;
  const change = f.service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'next-owner' }), abort.signal);
  await writing.promise;
  abort.abort();
  await expect(f.service.changePassword(principal, async () => ({ currentPassword: 'password-before', newPassword: 'next-password' }))).rejects.toMatchObject({ code: 'AUTH_BUSY' });
  finish.resolve();
  expect((await change).user.username).toBe('next-owner');
  expect(changes).toEqual(['credentials']);
  expect(f.store.isCurrent(principal.key, principal.credentialRevision)).toBe(false);
});

test('concurrent registration produces one account and one conflict', async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([f.register(), f.register()]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(value => value.status === 'rejected').reason.status).toBe(409);
});

test('credential admission precedes upload and is shared between both operations', async () => {
  const f = await fixture(); await f.register();
  const principal = await f.principal();
  const body = Promise.withResolvers();
  const first = f.service.changeUsername(principal, () => body.promise);
  let read = false;
  await expect(f.service.changePassword(principal, async () => { read = true; return {}; })).rejects.toMatchObject({ code: 'AUTH_BUSY' });
  expect(read).toBe(false);
  body.resolve({ currentPassword: 'password-before', username: 'next' });
  await first;
});

test('revision exhaustion cannot sign, write, or wrap', async () => {
  const f = await fixture(); await f.register();
  const snapshot = await f.store.snapshot();
  await f.store.commit(snapshot, () => ({ account: { ...snapshot.account, credentialRevision: Number.MAX_SAFE_INTEGER }, result: null }));
  await expect(f.service.changeUsername(await f.principal(), async () => ({ currentPassword: 'password-before', username: 'next' })))
    .rejects.toMatchObject({ code: 'AUTH_REVISION_EXHAUSTED' });
  expect((await f.store.snapshot()).account.credentialRevision).toBe(Number.MAX_SAFE_INTEGER);
});
