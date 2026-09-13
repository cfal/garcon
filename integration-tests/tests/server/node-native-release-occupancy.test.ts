import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { ProviderConfigurationRequest } from '../../../server/execution-nodes/provider-configuration.js';
import type { ProviderNativeSessionRequest } from '../../../server/execution-nodes/provider-native-sessions.js';
import { RemoteProviderNativeSessionService } from '../../../server/execution-nodes/remote-provider-native-sessions.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { withTimeout } from '../../support/deferred.js';
import { TlsCertificates } from '../../support/tls-certificates.js';

test.skipIf(!nodeSessionSystemdAvailable)('native deletion waits for exact-chat settlement even when the instance has spare capacity', async () => {
  const certificates = await TlsCertificates.create();
  const response = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const model = Bun.serve({ hostname: '0.0.0.0', port: 0, async fetch(request) {
    await request.json();
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {}\n\n')); response.resolve(controller);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  let fixture: Awaited<ReturnType<typeof createNodeSessionOutputFixture>> | null = null;
  try {
    fixture = await createNodeSessionOutputFixture(await certificates.selfSigned('native-release-occupancy'), { maxOperations: 2 });
    const f = fixture;
    await f.recover();
    const stream = await f.install('synthetic-native-stream', { signal: f.signal, emit() {} });
    const configuration: ProviderConfigurationRequest = { model: 'synthetic-model', settings: null, thinkingMode: 'none',
      endpoint: { credential: null, selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
        providerLabel: 'Synthetic', protocol: 'anthropic-messages', model: 'synthetic-model', isLocal: true,
        baseUrl: `http://127.0.0.1:${model.port}`, capabilities: null, headers: {} } } };
    const chatId = '1000000000000000';
    const started = await f.start(stream, chatId, 'synthetic-run', configuration, 'synthetic native input');
    expect(started.result).toEqual({ kind: 'dispatched' });
    const activeResponse = await withTimeout(response.promise, 5000, () => 'Synthetic model request missing');
    const event = await f.waitFor(stream, (event) => event.type === 'session');
    if (event.type !== 'session') throw new Error('Synthetic native binding missing');
    const service = new RemoteProviderNativeSessionService(f.controller.client.service,
      { nodeId: f.host.pairing.nodeId, instanceId: 'synthetic-instance' }, () => ({ nodeId: f.host.pairing.nodeId, workspaceId: 'synthetic-workspace' }));
    const request: ProviderNativeSessionRequest = { chat: { chatId, agentId: 'direct-anthropic-compatible',
      agentSessionId: event.session.agentSessionId, nativeSession: event.session.nativeSession,
      projectPath: f.host.storage, model: 'synthetic-model', settings: null, carryOverRevision: '', nativeSeedReceipt: null } };
    const source = await service.describe(request, f.signal);
    if (source?.kind !== 'filesystem-path') throw new Error('Synthetic native path missing');
    await expect(service.release({ ...request, reason: 'deleted' }, f.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    expect(existsSync(source.value)).toBe(true);
    activeResponse.enqueue(new TextEncoder().encode('data: {"type":"message_stop"}\n\n')); activeResponse.close();
    const execution = f.controller.client.execution('synthetic-instance');
    await withTimeout((async () => {
      while (!f.signal.aborted) {
        const result = await execution.call({ method: 'status', identity: started.identity }, f.signal);
        if (result.kind === 'status' && result.receipt?.native === 'settled') return;
        await new Promise(setImmediate);
      }
      throw new Error('Synthetic execution lost authority');
    })(), 5000, () => 'Synthetic native execution did not settle');
    await service.release({ ...request, reason: 'deleted' }, f.signal);
    expect(existsSync(source.value)).toBe(false);
    expect(f.host.containmentRequests).toEqual([]);
  } finally { await fixture?.dispose(); await model.stop(true); await certificates.dispose(); }
}, 20_000);
