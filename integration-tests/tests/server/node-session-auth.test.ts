import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RemoteProviderAuthService } from '../../../server/execution-nodes/remote-provider-auth.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { withTimeout } from '../../support/deferred.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('auth-session'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('instance authentication over WSS', () => {
  test('a lost login reply stays unknown and reconnect does not launch login again', async () => {
    const f = await createNodeSessionFixture(certificate);
    try {
      let launches = 0;
      f.nodeFrames.add((frame) => {
        if (frame.type === 'node-worker-service-request' && frame.command.method === 'provider-auth' && frame.command.operation === 'launch-login') launches++;
      });
      const first = f.connect(); const connection = await first.ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const dropped = Promise.withResolvers<void>();
      const drop: Parameters<typeof f.controllerFrames.add>[0] = (frame) => {
        if (frame.type !== 'node-worker-service-result' || frame.result.kind !== 'provider-auth-rejected') return true;
        f.controllerFrames.delete(drop); first.stop(); dropped.resolve(); return false;
      };
      f.controllerFrames.add(drop);
      const mutation = expect(new RemoteProviderAuthService(controller.client.service, 'synthetic-instance').launchLogin())
        .rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN', retryable: false });
      await withTimeout(dropped.promise, 5000, () => 'Synthetic login reply never reached the dropped frame');
      await mutation; await first.closed;
      expect(launches).toBe(1);
      const second = f.connect(); const replacement = await second.ready;
      const current = await f.controller(replacement);
      await recover(current);
      expect(await new RemoteProviderAuthService(current.client.service, 'synthetic-instance').loginStatus({ sessionId: null }, current.signal))
        .toEqual({ state: 'idle', running: false });
      expect(launches).toBe(1);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 20_000);

  test('auth metadata, status, unsupported login and reconnect retain the configured owner', async () => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const first = f.connect(); const connection = await first.ready;
      const controller = await f.controller(connection);
      const auth = new RemoteProviderAuthService(controller.client.service, 'synthetic-instance');
      await expect(auth.status(controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true });
      const manifest = (await f.accepted.at(-1)!.ready).manifests[0]!;
      expect(manifest.facets.auth).toBe(true);
      expect(manifest.authCapabilities).toEqual({ launchLogin: false, completeLogin: false });
      await recover(controller);
      expect(await auth.status(controller.signal)).toMatchObject({ authenticated: false, canReauth: false, source: 'none' });
      expect(await auth.loginStatus({ sessionId: null }, controller.signal)).toEqual({ state: 'idle', running: false });
      await expect(auth.launchLogin()).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', retryable: false });
      await expect(auth.completeLogin({ sessionId: 'synthetic-login', code: 'synthetic-code' })).rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', retryable: false });
      await expect(new RemoteProviderAuthService(controller.client.service, 'foreign-instance').status(controller.signal))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', retryable: false });
      expect(controller.signal.aborted).toBe(false);
      first.stop(); await first.closed;
      const second = f.connect(); const replacement = await second.ready;
      const current = await f.controller(replacement);
      await recover(current);
      await expect(auth.status(new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      expect(await new RemoteProviderAuthService(current.client.service, 'synthetic-instance').status(current.signal))
        .toMatchObject({ authenticated: false, source: 'none' });
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 20_000);

  test('real pinned Pi readiness comes from the instance native profile without a model call', async () => {
    const provider = startScriptedPiTestEnvironment();
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      instance: { agentId: 'pi', environment: { GARCON_PI_BINARY: provider.serverEnvironment.GARCON_PI_BINARY! } },
    });
    try {
      const home = path.join(f.storage, 'native');
      await mkdir(path.join(home, '.pi', 'agent'), { recursive: true, mode: 0o700 });
      await provider.prepareWorkspace({ root: f.storage, home, config: path.join(f.storage, 'config'),
        workspace: path.join(f.storage, 'workspace'), project: f.storage });
      const physical = f.connect(); const connection = await physical.ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const auth = new RemoteProviderAuthService(controller.client.service, 'synthetic-instance');
      expect(await auth.status(controller.signal)).toMatchObject({ authenticated: true, canReauth: false, source: 'cli' });
      expect(provider.model.requests()).toEqual([]);
    } finally { await f.dispose(); provider.dispose(); }
  }, 20_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const begin = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (begin.kind !== 'output-recovery') throw new Error('Synthetic auth recovery did not begin');
  expect(await controller.client.service.call({ method: 'replay-output', generation: begin.generation, cursors: [] }, controller.signal))
    .toEqual({ kind: 'output-replayed', ranges: [] });
  expect(await controller.client.service.call({ method: 'resume-output', generation: begin.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
