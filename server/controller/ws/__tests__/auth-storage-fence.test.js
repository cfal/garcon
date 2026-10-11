import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const jsonStore = await import('../../../common/json-file-store.js');
const writeJsonFileAtomic = jsonStore.writeJsonFileAtomic;
let failAfterRename = false;
mock.module('../../../common/json-file-store.js', () => ({
  ...jsonStore,
  writeJsonFileAtomic: async (...args) => {
    await writeJsonFileAtomic(...args);
    if (failAfterRename) throw new jsonStore.AtomicJsonWriteError('Synthetic durability failure', true);
  },
}));

const { getAuthStore } = await import('../../auth/store.js');
const { AuthService } = await import('../../auth/service.js');
const { fixturePasswords } = await import('../../auth/__tests__/fixture.js');
const { verifyAuthTokenClaims } = await import('../../auth/token.js');
const { resetServerConfigForTests } = await import('../../config.js');
const { PrimarySocketDelivery } = await import('../primary-delivery.js');
const { WebSocketAdmissionController } = await import('../../../common/websocket-capacity.js');
const { createServerSocketHandlers } = await import('../server-sockets.js');
const { AUTH_UNAVAILABLE_CLOSE_CODE, AUTH_UNAVAILABLE_CLOSE_REASON } = await import('../../../../common/ws-auth.js');

const previousConfig = process.env.GARCON_CONFIG_DIR;
let directory;
afterEach(async () => {
  failAfterRename = false;
  if (previousConfig === undefined) delete process.env.GARCON_CONFIG_DIR;
  else process.env.GARCON_CONFIG_DIR = previousConfig;
  resetServerConfigForTests();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.each(['open', 'message'])('storage fencing has a distinct close reason at browser %s admission', async phase => {
  directory = await mkdtemp(join(homedir(), 'garcon-ws-storage-fence-'));
  process.env.GARCON_CONFIG_DIR = directory;
  resetServerConfigForTests();
  const service = new AuthService(getAuthStore(), fixturePasswords);
  const session = await service.register({ username: 'synthetic-owner', password: 'synthetic-password' });
  const claims = await verifyAuthTokenClaims(session.token);
  const principal = { mode: 'authenticated', key: claims.ownerKey, username: claims.username,
    credentialRevision: claims.credentialRevision, expiresAtMs: claims.expiresAtMs };
  const socket = { data: { kind: 'primary', connectionId: 'captured-upgrade', principal },
    readyState: 1, close: mock(() => {}) };
  const admission = new WebSocketAdmissionController(1);
  const delivery = new PrimarySocketDelivery(1024);
  const primary = { open: mock(() => {}), message: mock(() => {}), drain() {}, close: mock(() => {}) };
  const handlers = createServerSocketHandlers({ admission, delivery, primary,
    config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength: 1024 },
    logger: { error() {} }, execution: { message() {} } });
  admission.tryReserve(socket.data.connectionId);
  if (phase === 'message') handlers.open(socket);

  failAfterRename = true;
  await expect(service.changeUsername(principal, async () => ({
    currentPassword: 'synthetic-password', username: 'synthetic-next',
  }))).rejects.toMatchObject({ code: 'AUTH_STORAGE_UNAVAILABLE' });
  if (phase === 'open') handlers.open(socket);
  else await handlers.message(socket, '{}');

  expect(socket.close).toHaveBeenCalledWith(AUTH_UNAVAILABLE_CLOSE_CODE, AUTH_UNAVAILABLE_CLOSE_REASON);
  expect(admission.size).toBe(0);
  expect(delivery.get(socket)).toBeUndefined();
  expect(primary.open).toHaveBeenCalledTimes(phase === 'open' ? 0 : 1);
  expect(primary.message).not.toHaveBeenCalled();
  if (phase === 'message') expect(primary.close).toHaveBeenCalledWith(
    expect.objectContaining({ readyState: 3 }), AUTH_UNAVAILABLE_CLOSE_CODE, AUTH_UNAVAILABLE_CLOSE_REASON,
  );
});
