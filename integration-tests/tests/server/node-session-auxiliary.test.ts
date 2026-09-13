import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RemoteProviderAuxiliaryService } from '../../../server/execution-nodes/remote-provider-auxiliary.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { withTimeout } from '../../support/deferred.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('auxiliary-session'); });
afterAll(async () => certificates?.dispose());

const families = [
  { agentId: 'direct-openai-compatible', protocol: 'openai-compatible',
    body: 'data: {"choices":[{"delta":{"content":"synthetic response"}}]}\n\ndata: [DONE]\n\n' },
  { agentId: 'direct-openai-responses-compatible', protocol: 'openai-compatible',
    body: 'data: {"type":"response.output_text.delta","delta":"synthetic response"}\n\ndata: {"type":"response.completed","response":{"id":"synthetic-response"}}\n\n' },
  { agentId: 'direct-anthropic-compatible', protocol: 'anthropic-messages',
    body: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"synthetic response"}}\n\ndata: {"type":"message_stop"}\n\n' },
] as const;

describe.skipIf(!nodeSessionSystemdAvailable)('retained auxiliary work over authenticated WSS and both worker hops', () => {
  test('a lost generation reply stays unknown across reconnect without repeating the mutation', async () => {
    let requests = 0;
    const model = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch() {
      requests++;
      return new Response(families[0].body, { headers: { 'content-type': 'text/event-stream' } });
    } });
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instance: { agentId: families[0].agentId, environment: {} } });
    try {
      const first = f.connect();
      const connection = await first.ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
      const request = { prompt: 'synthetic input', timeoutMs: 10_000, configuration: { model: 'synthetic-model', settings: null,
        endpoint: { credential: null, selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic',
          protocol: families[0].protocol, baseUrl: `http://127.0.0.1:${model.port}`, model: 'synthetic-model', isLocal: true, capabilities: null, headers: {} } } } };
      const dropped = Promise.withResolvers<void>();
      const drop: Parameters<typeof f.controllerFrames.add>[0] = (frame) => {
        if (frame.type !== 'node-worker-service-result' || frame.result.kind !== 'provider-auxiliary-result') return true;
        f.controllerFrames.delete(drop); first.stop(); dropped.resolve(); return false;
      };
      f.controllerFrames.add(drop);
      const outcome = expect(service.generate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
      await withTimeout(dropped.promise, 5000, () => 'Synthetic generation reply did not reach the drop');
      await outcome;
      await first.closed;
      expect(requests).toBe(1);
      const replacement = await f.connect().ready;
      const recovered = await f.controller(replacement);
      await recover(recovered);
      expect(replacement.lease.session).toEqual(connection.lease.session);
      await expect(service.generate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      expect(requests).toBe(1);
      const refreshed = new RemoteProviderAuxiliaryService(recovered.client.service, 'synthetic-instance', replacement.lease.session);
      expect(await refreshed.generate(request, recovered.signal)).toBe('synthetic response');
      expect(requests).toBe(2);
    } finally { await f.dispose(); await model.stop(true); }
  }, 25_000);

  test.each([...families])('$agentId charges chat capacity through response EOF and keeps private facets unadvertised', async (family) => {
    const requested = Promise.withResolvers<void>();
    const payloads: unknown[] = [];
    let body: ReadableStreamDefaultController<Uint8Array> | null = null;
    let held = true;
    const model = Bun.serve({ hostname: '0.0.0.0', port: 0, idleTimeout: 15,
      async fetch(request) {
        payloads.push(await request.json());
        const response = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(family.body));
          if (held) body = controller;
          else controller.close();
        } });
        requested.resolve();
        return new Response(response, { headers: { 'content-type': 'text/event-stream' } });
      } });
    const f = await createNodeSessionFixture(certificate, certificate.trust, { instance: { agentId: family.agentId, environment: {} }, maxOperations: 1 });
    try {
      const physical = f.connect();
      const connection = await physical.ready;
      const controller = await f.controller(connection);
      const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
      const manifest = (await f.accepted.at(-1)!.ready).manifests[0]!;
      expect(manifest.facets.execution).toBeNull();
      expect(manifest.facets.singleQuery).toBeNull();
      expect(manifest.facets.textGeneration).toBeNull();
      const request = { prompt: 'synthetic input', timeoutMs: 10_000, configuration: { model: 'synthetic-model', settings: null,
        endpoint: { credential: null, selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint', providerLabel: 'Synthetic',
          protocol: family.protocol, baseUrl: `http://127.0.0.1:${model.port}`, model: 'synthetic-model', isLocal: true, capabilities: null, headers: {} } } } };
      await expect(service.generate(request, controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
      expect(payloads).toHaveLength(0);
      await recover(controller);
      let completed = false;
      const generating = service.generate(request, controller.signal).then((value) => { completed = true; return value; });
      await withTimeout(requested.promise, 5000, () => 'Synthetic auxiliary request did not reach its model');
      const prepare = { method: 'prepare', location: { nodeId: manifest.nodeId, instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
        request: { kind: 'start', chatId: '1789000000000001', runId: 'synthetic-run', configuration: request.configuration } } as const;
      expect(await controller.client.execution('synthetic-instance').call(prepare, controller.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
      expect(completed).toBe(false);
      held = false;
      if (!body) throw new Error('Synthetic model body was not captured');
      (body as ReadableStreamDefaultController<Uint8Array>).close();
      body = null;
      expect(await generating).toBe('synthetic response');
      expect(await service.singleQuery('synthetic-workspace', request, controller.signal)).toBe('synthetic response');
      const prepared = await controller.client.execution('synthetic-instance').call(prepare, controller.signal);
      expect(prepared.kind).toBe('prepared');
      if (prepared.kind !== 'prepared') throw new Error('Native auxiliary capacity was not released');
      expect(await controller.client.execution('synthetic-instance').call({ method: 'release', identity: prepared.ticket.identity }, controller.signal)).toEqual({ kind: 'released' });
      expect(payloads).toHaveLength(2);
      for (const payload of payloads) expect(payload).not.toHaveProperty('tools');
    } finally {
      if (body) { try { (body as ReadableStreamDefaultController<Uint8Array>).close(); } catch {} }
      await f.dispose();
      await model.stop(true);
    }
  }, 25_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const begin = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (begin.kind !== 'output-recovery') throw new Error('Synthetic auxiliary recovery did not begin');
  await controller.client.service.call({ method: 'replay-output', generation: begin.generation, cursors: [] }, controller.signal);
  expect(await controller.client.service.call({ method: 'resume-output', generation: begin.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
