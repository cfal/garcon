import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RemoteProviderConfigurationService } from '../../../server/execution-nodes/remote-provider-configuration.js';
import type { ProviderConfigurationUpdateRequest } from '../../../server/execution-nodes/provider-configuration.js';
import type { AgentEndpointSelection } from '../../../common/agent-execution.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('configuration-session'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('instance settings preparation over WSS', () => {
  test.each(['direct-anthropic-compatible', 'opencode'])('uses %s validation with owned snapshots across physical reconnect', async (agentId) => {
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instance: { agentId, environment: {} } });
    const request: ProviderConfigurationUpdateRequest = { previous: { model: 'synthetic-original', settings: null, endpoint: null },
      next: { model: 'synthetic-next', endpoint: null }, patch: { thinkingMode: 'low', permissionMode: undefined, settings: undefined } };
    try {
      const first = f.connect(); const connection = await first.ready;
      const controller = await f.controller(connection);
      let channel = { session: connection.lease.session, service: controller.client.service };
      const service = new RemoteProviderConfigurationService({ captureSource: () => null, instanceId: 'synthetic-instance', session: connection.lease.session, channel: () => channel });
      await expect(service.prepareUpdate(request, controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      const manifest = (await f.accepted.at(-1)!.ready).manifests[0]!;
      expect(manifest.facets.sessionConfiguration).toBeNull();
      await recover(controller);
      const prepared = await service.prepareUpdate(request, controller.signal);
      expect(prepared.previous).toMatchObject({ model: 'synthetic-original', permissionMode: 'default', thinkingMode: 'none', endpoint: null,
        settings: { ownerId: agentId } });
      expect(prepared.next).toMatchObject({ model: 'synthetic-next', permissionMode: 'default', thinkingMode: 'low', endpoint: null,
        settings: { ownerId: agentId } });
      expect(prepared.previous.settings).not.toBe(prepared.next.settings);
      if (agentId === 'opencode') await expect(service.prepareUpdate({ ...request, patch: { thinkingMode: 'ultra' } }, controller.signal))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, retryable: false });
      const endpoint: AgentEndpointSelection = { apiProviderId: 'synthetic-api', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic endpoint',
        protocol: 'anthropic-messages', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-next', isLocal: false,
        capabilities: null, headers: { 'X-Synthetic': 'original' } };
      const withEndpoint = { ...request, next: { ...request.next, endpoint } };
      if (agentId === 'direct-anthropic-compatible') {
        const selected = await service.prepareUpdate(withEndpoint, controller.signal);
        expect(selected.next.endpoint).toEqual(endpoint);
        await expect(service.prepareUpdate({ ...withEndpoint, next: { ...withEndpoint.next, endpoint: { ...endpoint, protocol: 'openai-compatible' } } }, controller.signal))
          .rejects.toMatchObject({ code: 'INVALID_ENDPOINT', retryable: false });
      } else {
        await expect(service.prepareUpdate(withEndpoint, controller.signal)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT', retryable: false });
      }
      await expect(new RemoteProviderConfigurationService({ captureSource: () => null, instanceId: 'foreign-instance', session: connection.lease.session, channel: () => channel }).prepareUpdate(request, controller.signal))
        .rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', retryable: false });
      expect(controller.signal.aborted).toBe(false);
      first.stop(); await first.closed;
      const second = f.connect(); const replacement = await second.ready;
      const current = await f.controller(replacement);
      await recover(current);
      expect(replacement.lease.session).toEqual(connection.lease.session);
      await expect(service.prepareUpdate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      channel = { session: replacement.lease.session, service: current.client.service };
      expect(await service.prepareUpdate(request, current.signal)).toEqual(prepared);
      expect(f.processes.size).toBe(1);
    } finally { await f.dispose(); }
  }, 20_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const begin = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (begin.kind !== 'output-recovery') throw new Error('Synthetic configuration recovery did not begin');
  expect(await controller.client.service.call({ method: 'replay-output', generation: begin.generation, cursors: [] }, controller.signal))
    .toEqual({ kind: 'output-replayed', ranges: [] });
  expect(await controller.client.service.call({ method: 'resume-output', generation: begin.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
