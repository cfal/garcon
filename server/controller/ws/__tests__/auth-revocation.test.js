import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAuthStore } from '../../auth/store.js';
import { AuthService } from '../../auth/service.js';
import { fixturePasswords } from '../../auth/__tests__/fixture.js';
import { resetServerConfigForTests } from '../../config.js';
import { PrimarySocketDelivery } from '../primary-delivery.js';
import { WebSocketAdmissionController } from '../../../common/websocket-capacity.js';
import { createServerSocketHandlers } from '../server-sockets.js';

let server;
let directory;
const previous = process.env.GARCON_CONFIG_DIR;
afterEach(async () => {
  await server?.stop(true);
  if (previous === undefined) delete process.env.GARCON_CONFIG_DIR;
  else process.env.GARCON_CONFIG_DIR = previous;
  resetServerConfigForTests();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('a browser verified before rotation cannot open afterward, but its replacement can', async () => {
  directory = await mkdtemp(join(homedir(), 'garcon-ws-auth-test-'));
  process.env.GARCON_CONFIG_DIR = directory; resetServerConfigForTests();
  const service = new AuthService(getAuthStore(), fixturePasswords);
  await service.register({ username: 'owner-before', password: 'password-before' });
  const principal = { mode: 'authenticated', key: 'owner-before', username: 'owner-before', credentialRevision: 1,
    expiresAtMs: Date.now() + 60_000 };
  await service.changeUsername(principal, async () => ({ currentPassword: 'password-before', username: 'owner-after' }));
  const admission = new WebSocketAdmissionController(2);
  const delivery = new PrimarySocketDelivery(1024);
  let opened = 0;
  server = Bun.serve({ hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      const connectionId = crypto.randomUUID(); admission.tryReserve(connectionId);
      const next = new URL(request.url).pathname === '/next';
      server.upgrade(request, { data: { kind: 'primary', connectionId,
        principal: next ? { ...principal, username: 'owner-after', credentialRevision: 2 } : principal } });
    },
    websocket: createServerSocketHandlers({ admission, delivery, logger: { error() {} }, execution: { message() {} },
      config: { wsIdleTimeoutSeconds: 60, wsBackpressureLimit: 1024, wsMaxPayloadLength: 1024 },
      primary: { open() { opened++; }, message() {}, drain() {}, close() {} } }),
  });
  const old = new WebSocket(`ws://127.0.0.1:${server.port}/old`);
  const close = await new Promise(resolve => { old.onclose = resolve; });
  expect(close.code).toBe(4001); expect(opened).toBe(0); expect(admission.size).toBe(0);
  const next = new WebSocket(`ws://127.0.0.1:${server.port}/next`);
  await new Promise(resolve => { next.onopen = resolve; });
  expect(opened).toBe(1); expect(admission.size).toBe(1);
  next.close();
});
