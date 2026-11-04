import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { getAuthStore, AuthAccountStore } from '../store.js';
import { AuthService } from '../service.js';
import { verifyAuthTokenClaims, signAuthSnapshot } from '../token.js';
import { resetServerConfigForTests } from '../../config.js';
import { fixturePasswords } from './fixture.js';
import { assertPermissionDecisionAuthority } from '../../agents/permission-authority.js';

let directory;
let previous;
let service;
beforeEach(async () => {
  previous = process.env.GARCON_CONFIG_DIR;
  directory = await mkdtemp(join(tmpdir(), 'garcon-token-test-'));
  process.env.GARCON_CONFIG_DIR = directory;
  resetServerConfigForTests();
  service = new AuthService(getAuthStore(), fixturePasswords);
});
afterEach(async () => {
  if (previous === undefined) delete process.env.GARCON_CONFIG_DIR;
  else process.env.GARCON_CONFIG_DIR = previous;
  resetServerConfigForTests();
  await rm(directory, { recursive: true, force: true });
});

test('only current HS256 owner/revision tokens authenticate, including after restart', async () => {
  const first = await service.register({ username: 'owner-before', password: 'password-before' });
  const snapshot = await getAuthStore().snapshot();
  const claims = await verifyAuthTokenClaims(first.token);
  expect(claims).toMatchObject({ ownerKey: 'owner-before', username: 'owner-before', credentialRevision: 1 });
  const restart = await new AuthAccountStore(join(directory, 'auth.json')).snapshot();
  expect(jwt.verify(first.token, restart.jwtSecret).credentialRevision).toBe(restart.account.credentialRevision);
  const changed = await service.changeUsername({ mode: 'authenticated', key: claims.ownerKey, ...claims },
    async () => ({ currentPassword: 'password-before', username: 'owner-after' }));
  expect(await verifyAuthTokenClaims(first.token)).toBeNull();
  expect(await verifyAuthTokenClaims(changed.token)).toMatchObject({ username: 'owner-after', ownerKey: 'owner-before', credentialRevision: 2 });
  expect(await verifyAuthTokenClaims(signAuthSnapshot(snapshot, {
    ownerKey: claims.ownerKey, sessionId: claims.sessionId, expiresAtMs: claims.expiresAtMs,
  }))).toBeNull();
});

test('rejects legacy, malformed, missing, expired and wrong-algorithm tokens', async () => {
  const first = await service.register({ username: 'owner', password: 'password-test' });
  const { jwtSecret } = await getAuthStore().snapshot();
  const claims = { sub: 'owner', credentialRevision: 1, sid: jwt.decode(first.token).sid };
  for (const token of [null, 'not-a-token',
    jwt.sign({ username: 'owner' }, jwtSecret, { expiresIn: '1h' }),
    jwt.sign({ sub: 'owner', credentialRevision: 1 }, jwtSecret, { expiresIn: '1h' }),
    jwt.sign(claims, jwtSecret),
    jwt.sign({ ...claims, credentialRevision: 0 }, jwtSecret, { expiresIn: '1h' }),
    jwt.sign({ ...claims, sub: 'another-owner' }, jwtSecret, { expiresIn: '1h' }),
    jwt.sign(claims, jwtSecret, { expiresIn: -1 }),
    jwt.sign(claims, jwtSecret, { algorithm: 'HS384', expiresIn: '1h' }),
  ]) expect(await verifyAuthTokenClaims(token)).toBeNull();
});

test('guarded permission authority requires a current browser credential and session', async () => {
  const { token } = await service.register({ username: 'synthetic-owner', password: 'synthetic-password' });
  const claims = await verifyAuthTokenClaims(token);
  const principal = { mode: 'authenticated', key: claims.ownerKey, ...claims };
  const policy = { permissionDecisionAuthority: 'browser-session' };
  expect(() => assertPermissionDecisionAuthority(policy, principal)).not.toThrow();
  for (const changed of [{ ...principal, credentialRevision: 0 }, { ...principal, sessionId: 'stale' },
    { ...principal, expiresAtMs: 1 }, { mode: 'local', key: 'local' }, null]) {
    expect(() => assertPermissionDecisionAuthority(policy, changed)).toThrow('authenticated browser session');
  }
  await getAuthStore().revokeSession(principal.key, principal.sessionId);
  expect(() => assertPermissionDecisionAuthority(policy, principal)).toThrow('authenticated browser session');
  expect(() => assertPermissionDecisionAuthority(undefined, null)).not.toThrow();
});
