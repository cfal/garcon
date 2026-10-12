import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const jsonStore = await import('../../../common/json-file-store.js');
const writeJsonFileAtomic = jsonStore.writeJsonFileAtomic;
let pendingWrite = null;
mock.module('../../../common/json-file-store.js', () => ({
  ...jsonStore,
  writeJsonFileAtomic: (...args) => {
    if (!pendingWrite) return writeJsonFileAtomic(...args);
    const { persisted, outcome } = pendingWrite;
    void writeJsonFileAtomic(...args).then(persisted.resolve, persisted.reject);
    return outcome.promise;
  },
}));

const { resetServerConfigForTests } = await import('../../config.js');
const { getAuthStore } = await import('../store.js');
const { AuthService } = await import('../service.js');
const { verifyAuthTokenClaims } = await import('../token.js');
const { authenticateHttpRequest } = await import('../../lib/http-request.js');
const { default: routes } = await import('../../routes/auth.js');
const { fixturePasswords } = await import('./fixture.js');

const previousConfig = process.env.GARCON_CONFIG_DIR;
const previousDisabled = process.env.GARCON_AUTH_DISABLED;
let directory;
afterEach(async () => {
  pendingWrite = null;
  if (previousConfig === undefined) delete process.env.GARCON_CONFIG_DIR;
  else process.env.GARCON_CONFIG_DIR = previousConfig;
  if (previousDisabled === undefined) delete process.env.GARCON_AUTH_DISABLED;
  else process.env.GARCON_AUTH_DISABLED = previousDisabled;
  resetServerConfigForTests();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function registerAccount(prefix) {
  directory = await mkdtemp(join(tmpdir(), prefix));
  process.env.GARCON_CONFIG_DIR = directory;
  process.env.GARCON_AUTH_DISABLED = 'false';
  resetServerConfigForTests();
  const store = getAuthStore();
  const service = new AuthService(store, fixturePasswords);
  const first = await service.register({ username: 'synthetic-owner', password: 'password-before' });
  return { store, service, first };
}

test('auth reads that straddle an uncertain write preserve the storage fence', async () => {
  const { service, first } = await registerAccount('garcon-auth-fence-race-');
  const principal = { mode: 'authenticated', key: first.user.id, username: first.user.username,
    ...(await verifyAuthTokenClaims(first.token)) };
  pendingWrite = { persisted: Promise.withResolvers(), outcome: Promise.withResolvers() };
  const change = service.changeUsername(principal,
    async () => ({ currentPassword: 'password-before', username: 'synthetic-next' })).catch(error => error);
  await pendingWrite.persisted.promise;
  expect(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).credentialRevision).toBe(2);

  const claims = verifyAuthTokenClaims(first.token).catch(error => error);
  const auth = authenticateHttpRequest(new Request('http://localhost/api/private', {
    headers: { Authorization: `Bearer ${first.token}` },
  }));
  const statusUrl = new URL('http://localhost/api/v1/auth/status');
  const status = routes[statusUrl.pathname].GET(new Request(statusUrl), statusUrl);
  const userUrl = new URL('http://localhost/api/v1/auth/user');
  const user = routes[userUrl.pathname].GET(new Request(userUrl), userUrl, undefined, { principal });
  pendingWrite.outcome.reject(new jsonStore.AtomicJsonWriteError('Synthetic directory sync failure', true));

  expect((await change).code).toBe('AUTH_STORAGE_UNAVAILABLE');
  expect((await claims).code).toBe('AUTH_STORAGE_UNAVAILABLE');
  for (const response of [(await auth).errorResponse, await status, await user]) {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorCode: 'AUTH_STORAGE_UNAVAILABLE', retryable: false });
  }
});

test('a user probe cannot validate a captured snapshot after successful rotation', async () => {
  const { store, service, first } = await registerAccount('garcon-auth-probe-race-');
  const snapshot = await store.snapshot();
  const principal = { mode: 'authenticated', key: first.user.id, username: first.user.username,
    ...(await verifyAuthTokenClaims(first.token)) };
  const pendingSnapshot = Promise.withResolvers();
  const capture = spyOn(store, 'snapshot').mockImplementationOnce(() => pendingSnapshot.promise);
  try {
    const url = new URL('http://localhost/api/v1/auth/user');
    const probe = routes[url.pathname].GET(new Request(url), url, undefined, { principal });
    await service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'synthetic-next' }));
    pendingSnapshot.resolve(snapshot);
    const response = await probe;
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ errorCode: 'AUTH_SESSION_INVALID' });
  } finally { capture.mockRestore(); }
});
