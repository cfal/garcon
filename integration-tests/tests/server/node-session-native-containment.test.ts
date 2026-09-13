import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { ProviderConfigurationRequest } from '../../../server/execution-nodes/provider-configuration.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { TlsCertificates } from '../../support/tls-certificates.js';
import { withTimeout } from '../../support/deferred.js';

const responseBody = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"synthetic response"}}\n\ndata: {"type":"message_stop"}\n\n';

test.skipIf(!nodeSessionSystemdAvailable)('an errored Direct response settles only its operation and preserves sibling native work across both worker hops', async () => {
  const certificates = await TlsCertificates.create();
  const firstRequest = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const siblingRequest = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  let requestCount = 0;
  let siblingCancelled = false;
  const model = Bun.serve({ hostname: '0.0.0.0', port: 0, async fetch(request) {
    await request.json();
    const index = ++requestCount;
    if (index > 2) return new Response(responseBody, { headers: { 'content-type': 'text/event-stream' } });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
        if (index === 1) firstRequest.resolve(controller);
        else siblingRequest.resolve(controller);
      },
      cancel() { if (index === 2) siblingCancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  let fixture: Awaited<ReturnType<typeof createNodeSessionOutputFixture>> | null = null;
  try {
    fixture = await createNodeSessionOutputFixture(await certificates.selfSigned('native-response-failure'), { maxOperations: 2 });
    const f = fixture;
    await f.recover();
    const first = await f.install('synthetic-failing-stream', { signal: f.signal, emit() {} });
    const sibling = await f.install('synthetic-sibling-stream', { signal: f.signal, emit() {} });
    const configuration: ProviderConfigurationRequest = { model: 'synthetic-model', settings: null, thinkingMode: 'none',
      endpoint: { credential: null, selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
        providerLabel: 'Synthetic', protocol: 'anthropic-messages', model: 'synthetic-model', isLocal: true,
        baseUrl: `http://127.0.0.1:${model.port}`, capabilities: null, headers: {} } } };
    const failed = await f.start(first, '1789000000000011', 'synthetic-failed-run', configuration, 'synthetic first input');
    const other = await f.start(sibling, '1789000000000012', 'synthetic-sibling-run', configuration, 'synthetic sibling input');
    expect(failed.result).toEqual({ kind: 'dispatched' });
    expect(other.result).toEqual({ kind: 'dispatched' });
    const response = await withTimeout(firstRequest.promise, 5000, () => 'Synthetic first response missing');
    const otherResponse = await withTimeout(siblingRequest.promise, 5000, () => 'Synthetic sibling response missing');
    const identity = (await f.host.marker.read())?.identity;
    if (!identity) throw new Error('Synthetic containment identity missing');
    response.error(new Error('Synthetic incomplete native response'));
    expect(await f.waitFor(first, (event) => event.type === 'run-ended'))
      .toMatchObject({ type: 'run-ended', runId: 'synthetic-failed-run', outcome: 'failed' });
    const execution = f.controller.client.execution('synthetic-instance');
    const receipt = await withTimeout((async () => {
      while (!f.signal.aborted) {
        const result = await execution.call({ method: 'status', identity: failed.identity }, f.signal);
        if (result.kind === 'status' && result.receipt?.native === 'settled') return result.receipt;
        await new Promise(setImmediate);
      }
      throw new Error('Synthetic response settlement lost authority');
    })(), 5000, () => 'Failed response did not settle');
    expect(receipt).toMatchObject({ phase: 'ended', native: 'settled', containment: null });
    expect(await execution.call({ method: 'status', identity: other.identity }, f.signal))
      .toMatchObject({ kind: 'status', receipt: { phase: 'dispatched', native: 'possible', containment: null } });
    expect(siblingCancelled).toBe(false);
    expect(f.host.containmentRequests).toEqual([]);
    expect(f.host.coordinator.supervisor.retirementReason).toBeNull();
    expect(f.connection.lease.authoritySignal.aborted).toBe(false);
    expect((await f.host.marker.read())?.identity).toEqual(identity);
    expect(existsSync(`/sys/fs/cgroup${identity.controlGroup}`)).toBe(true);
    const successor = await f.start(first, '1789000000000011', 'synthetic-successor-run', configuration, 'synthetic successor input');
    expect(successor.result).toEqual({ kind: 'dispatched' });
    expect(await f.waitFor(first, (event) => event.type === 'run-ended' && event.runId === 'synthetic-successor-run'))
      .toMatchObject({ type: 'run-ended', outcome: 'finished' });
    otherResponse.enqueue(new TextEncoder().encode(responseBody));
    otherResponse.close();
    expect(await f.waitFor(sibling, (event) => event.type === 'run-ended'))
      .toMatchObject({ type: 'run-ended', runId: 'synthetic-sibling-run', outcome: 'finished' });
    expect(f.host.containmentRequests).toEqual([]);
    expect(requestCount).toBe(3);
  } finally {
    await fixture?.dispose();
    await model.stop(true);
    await certificates.dispose();
  }
}, 20_000);
