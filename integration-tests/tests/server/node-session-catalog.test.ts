import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { RemoteProviderCatalogService } from '../../../server/execution-nodes/remote-provider-catalog.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { PI_TEST_MODEL, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { withTimeout } from '../../support/deferred.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('catalog-session'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('instance catalog discovery over WSS', () => {
  test.each(['claude', 'codex', 'direct-anthropic-compatible'])('preserves %s catalog metadata through the node workers', async (agentId) => {
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instance: { agentId, environment: {} } });
    try {
      const physical = f.connect(); const connection = await physical.ready;
      const controller = await f.controller(connection);
      const catalog = new RemoteProviderCatalogService(controller.client.service, 'synthetic-instance');
      await expect(catalog.snapshot({ strict: true }, controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true });
      const manifest = (await f.accepted.at(-1)!.ready).manifests[0]!;
      expect(manifest.descriptor.id).toBe(agentId);
      expect(Object.entries(manifest.facets).every(([name, present]) => present ===
        (name === 'catalog' || name === 'auth' || name === 'commands' && agentId !== 'direct-anthropic-compatible' ? true : null))).toBe(true);
      await recover(controller);
      const snapshot = await catalog.snapshot({ strict: true }, controller.signal);
      if (agentId !== 'direct-anthropic-compatible') expect(snapshot.models.length).toBeGreaterThan(0);
      expect(snapshot.requiresStrictModelDiscovery).toBe(false);
      const original = structuredClone(snapshot);
      if (snapshot.models[0]) snapshot.models[0].label = 'Synthetic caller mutation';
      expect(await catalog.snapshot({ strict: false }, controller.signal)).toEqual(original);
      await expect(new RemoteProviderCatalogService(controller.client.service, 'foreign-instance').snapshot({ strict: true }, controller.signal))
        .rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', nodeCode: 'VALIDATION_FAILED', retryable: false });
      expect(controller.signal.aborted).toBe(false);
    } finally { await f.dispose(); }
  }, 20_000);

  test('the real pinned Pi CLI discovers only its configured native profile without a model request', async () => {
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
      const snapshot = await new RemoteProviderCatalogService(controller.client.service, 'synthetic-instance').snapshot({ strict: true }, controller.signal);
      expect(snapshot.requiresStrictModelDiscovery).toBe(true);
      expect(snapshot.models.find(({ value }) => value === PI_TEST_MODEL))
        .toEqual({ value: PI_TEST_MODEL, label: 'garcon-fake: fake-model', supportsImages: false });
      expect(snapshot.generation).toBeNull();
      expect(provider.model.requests()).toEqual([]);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); provider.dispose(); }
  }, 20_000);

  test('a dropped catalog reply cannot reuse the old physical client or trigger an implicit retry', async () => {
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instance: { agentId: 'claude', environment: {} } });
    try {
      let reads = 0;
      f.nodeFrames.add((frame) => { if (frame.type === 'node-worker-service-request' && frame.command.method === 'provider-catalog') reads++; });
      const first = f.connect(); const connection = await first.ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const catalog = new RemoteProviderCatalogService(controller.client.service, 'synthetic-instance');
      const dropped = Promise.withResolvers<void>();
      const drop: Parameters<typeof f.controllerFrames.add>[0] = (frame) => {
        if (frame.type !== 'node-worker-service-result' || frame.result.kind !== 'provider-catalog') return true;
        f.controllerFrames.delete(drop); first.stop(); dropped.resolve(); return false;
      };
      f.controllerFrames.add(drop);
      const read = expect(catalog.snapshot({ strict: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      await withTimeout(dropped.promise, 5000, () => 'Synthetic catalog reply never reached the dropped frame');
      await read; await first.closed;
      expect(reads).toBe(1);
      const second = f.connect(); const replacement = await second.ready;
      const recovered = await f.controller(replacement);
      await recover(recovered);
      expect(replacement.lease.session).toEqual(connection.lease.session);
      await expect(catalog.snapshot({ strict: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      expect(reads).toBe(1);
      const refreshed = new RemoteProviderCatalogService(recovered.client.service, 'synthetic-instance');
      expect((await refreshed.snapshot({ strict: true }, recovered.signal)).models.length).toBeGreaterThan(0);
      expect(reads).toBe(2);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 20_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const begin = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (begin.kind !== 'output-recovery') throw new Error('Synthetic catalog recovery did not begin');
  expect(await controller.client.service.call({ method: 'replay-output', generation: begin.generation, cursors: [] }, controller.signal))
    .toEqual({ kind: 'output-replayed', ranges: [] });
  expect(await controller.client.service.call({ method: 'resume-output', generation: begin.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
