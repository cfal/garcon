import { afterEach, expect, test } from 'bun:test';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { AuthAccountStore } from '../store.js';
import { AtomicJsonWriteError, CorruptStateFileError, writeJsonFileAtomic } from '../../../common/json-file-store.js';
import { authFixture } from './fixture.js';

const fixtures = [];
async function fixture(options) { const value = await authFixture(options); fixtures.push(value); return value; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(value => value.dispose())); });

test('normalizes old ownership once and preserves secret, timestamps and private permissions', async () => {
  const f = await fixture();
  const original = { jwtSecret: 'synthetic-secret', username: 'owner-before', passwordHash: 'hash:password-before', createdAt: '2020-01-01T00:00:00.000Z' };
  await writeFile(f.filePath, JSON.stringify(original));
  const first = await f.store.snapshot();
  expect(first.account).toMatchObject({ username: original.username, passwordHash: original.passwordHash, createdAt: original.createdAt });
  expect(first.account.ownerKey).toBe('owner-before');
  expect(first.account.credentialRevision).toBe(1);
  expect((await stat(f.filePath)).mode & 0o777).toBe(0o600);
  await f.service.changeUsername(await f.principal(), async () => ({ currentPassword: 'password-before', username: 'owner-after' }));
  const restarted = await new AuthAccountStore(f.filePath).snapshot();
  expect(restarted.jwtSecret).toBe(original.jwtSecret);
  expect(restarted.account).toMatchObject({ ownerKey: 'owner-before', username: 'owner-after', credentialRevision: 2, createdAt: original.createdAt });
  expect(JSON.parse(await readFile(f.filePath, 'utf8'))).toMatchObject({ ownerKey: 'owner-before', credentialRevision: 2 });
});

test.each([
  '{', JSON.stringify({ username: 'owner' }),
  JSON.stringify({ unexpectedAccount: { username: 'owner' } }),
  JSON.stringify({ jwtSecret: 'secret', username: 'owner', passwordHash: 'hash', ownerKey: 'owner' }),
  JSON.stringify({ jwtSecret: 'secret', username: 'owner', passwordHash: 'hash', ownerKey: 'owner', credentialRevision: 0 }),
])('corrupt or partial accounts never reopen setup: %s', async raw => {
  const f = await fixture();
  await writeFile(f.filePath, raw);
  await expect(f.store.snapshot()).rejects.toBeInstanceOf(CorruptStateFileError);
  await expect(new AuthAccountStore(f.filePath).snapshot()).rejects.toBeInstanceOf(CorruptStateFileError);
});

test.each([false, true])('write failure preserves the correct authority, renamed=%s', async renamed => {
  let fail = false;
  const f = await fixture({ write: async (...args) => {
    if (!fail) return writeJsonFileAtomic(...args);
    if (renamed) await writeJsonFileAtomic(...args);
    throw new AtomicJsonWriteError('synthetic failure', renamed);
  } });
  await f.register();
  const previous = await f.store.snapshot();
  const principal = await f.principal();
  const changes = [];
  f.store.onChange(change => changes.push(change));
  fail = true;
  await expect(f.service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'owner-after' })))
    .rejects.toMatchObject({ code: renamed ? 'AUTH_STORAGE_UNAVAILABLE' : 'AUTH_SAVE_FAILED', retryable: false });
  expect(f.store.isCurrent(principal.key, 1)).toBe(!renamed);
  if (renamed) {
    expect(changes).toEqual(['storage-unavailable']);
    await expect(f.store.snapshot()).rejects.toMatchObject({ code: 'AUTH_STORAGE_UNAVAILABLE' });
    await expect(f.service.login({ username: 'owner-after', password: 'password-before' })).rejects.toMatchObject({ code: 'AUTH_STORAGE_UNAVAILABLE' });
    expect((await new AuthAccountStore(f.filePath).snapshot()).account.credentialRevision).toBe(2);
  } else {
    expect(changes).toEqual([]);
    expect(await f.store.snapshot()).toBe(previous);
  }
});

test('pre-writer failures retain the previous snapshot', async () => {
  let fail = false;
  const f = await fixture({ write: (...args) => { if (fail) throw new Error('synthetic mkdir failure'); return writeJsonFileAtomic(...args); } });
  await f.register();
  const previous = await f.store.snapshot();
  fail = true;
  await expect(f.service.changeUsername(await f.principal(), async () => ({ currentPassword: 'password-before', username: 'owner-after' })))
    .rejects.toMatchObject({ code: 'AUTH_SAVE_FAILED' });
  expect(await f.store.snapshot()).toBe(previous);
});
