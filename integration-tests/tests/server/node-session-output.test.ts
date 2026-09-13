import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import { MAX_NODE_OUTPUT_BYTES } from '../../../server-agents/interface/src/index.js';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import { parseNodeWorkerOutputText } from '../../../server/execution-node/worker/output-protocol.js';
import { parseNodeWorkerApplicationText, type NodeWorkerApplicationFrame } from '../../../server/execution-node/worker/application-protocol.js';
import type { ProviderConfigurationRequest } from '../../../server/execution-nodes/provider-configuration.js';
import { parseNodeExecutionReplyText } from '../../../server/execution-nodes/transport/execution-receipt-wire.js';
import { NodeSocketWriter } from '../../../server/execution-nodes/transport/socket-writer.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { withTimeout } from '../../support/deferred.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('output-session'); });
afterAll(async () => certificates?.dispose());

function model(respond: (index: number) => Promise<string>) {
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, async fetch(request) {
    expect(request.headers.get('x-api-key')).toBe('synthetic-credential');
    requests.push(await request.json());
    const index = requests.length;
    const content = await respond(index);
    const events = [
      { type: 'message_start', message: { id: `synthetic-${index}`, type: 'message', role: 'assistant', model: 'synthetic-model',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  const configuration: ProviderConfigurationRequest = { model: 'synthetic-model', settings: null, thinkingMode: 'none',
    endpoint: { credential: 'synthetic-credential', selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
      providerLabel: 'Synthetic', protocol: 'anthropic-messages', model: 'synthetic-model', isLocal: true,
      baseUrl: `http://127.0.0.1:${server.port}`, capabilities: null, headers: {} } } };
  return { requests, configuration, close: () => server.stop(true) };
}

describe.skipIf(!nodeSessionSystemdAvailable)('contained worker output over authenticated WSS', () => {
  test('successor installation waits for the acknowledged instance fence after both worker hops complete', async () => {
    const f = await createNodeSessionOutputFixture(certificate);
    const source = new AbortController();
    const firstFence = Promise.withResolvers<void>();
    const installationFence = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let restore = () => {};
    try {
      await f.recover();
      const output = await f.install('synthetic-retirement-source', { signal: source.signal, emit() {} });
      const service = f.host.coordinator.peer(f.connection).service(f.connection.connectionId);
      const call = service.call.bind(service);
      let confirmations = 0;
      let installations = 0;
      const held = spyOn(service, 'call').mockImplementation(async (command, signal) => {
        if (command.method === 'install-output') installations++;
        const result = await call(command, signal);
        if (command.method === 'retire-output') {
          expect(result).toEqual({ kind: 'output-fenced', instanceId: 'synthetic-instance', stream: output.stream });
          confirmations++;
          if (confirmations === 1) firstFence.resolve();
          else installationFence.resolve();
          await release.promise;
          signal.throwIfAborted();
        }
        return result;
      });
      restore = () => held.mockRestore();
      source.abort();
      await withTimeout(firstFence.promise, 5000, () => 'Synthetic retirement did not reach the instance');
      let installed = false;
      const successor = f.install('synthetic-retirement-successor', { signal: f.signal, emit() {} }).then((owner) => { installed = true; return owner; });
      void successor.catch(() => {});
      await withTimeout(installationFence.promise, 5000, () => 'Synthetic installation did not await retirement');
      expect(installed).toBe(false);
      expect(installations).toBe(0);
      expect(await f.controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' }, f.signal))
        .toMatchObject({ kind: 'provider-auth-status' });
      release.resolve();
      expect((await successor).retired).toBe(false);
      expect(installations).toBe(1);
      expect(output.retired).toBe(true);
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      expect(f.failures).toEqual([]);
    } finally { release.resolve(); restore(); await f.dispose(); }
  }, 20_000);

  test('a lost retirement acknowledgement stays unconfirmed and its logical record survives reconnect', async () => {
    const f = await createNodeSessionOutputFixture(certificate);
    const lost = Promise.withResolvers<void>();
    const stream = { ...f.session, streamId: 'synthetic-preinstall-retirement' };
    const drop = (frame: NodeWorkerApplicationFrame) => {
      if (frame.type !== 'node-worker-service-result' || frame.result.kind !== 'output-fenced') return true;
      lost.resolve();
      return false;
    };
    try {
      await f.recover();
      f.host.controllerFrames.add(drop);
      const retiring = f.controller.client.retireOutput({ instanceId: 'synthetic-instance', stream }, f.controller.signal);
      void retiring.catch(() => {});
      await withTimeout(lost.promise, 5000, () => 'Synthetic fence reply was not observed');
      await f.disconnect();
      await expect(retiring).rejects.toBeInstanceOf(Error);
      f.host.controllerFrames.delete(drop);
      await f.reconnect(); await f.recover();
      const result = await f.controller.client.service.call({ method: 'install-output', instanceId: 'synthetic-instance', stream }, f.controller.signal);
      expect(result).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
      expect((await f.install('synthetic-retirement-sibling', { signal: f.signal, emit() {} })).retired).toBe(false);
      expect(f.host.coordinator.supervisor.status).toBe('online');
      expect(f.host.processes.size).toBe(1);
      expect(f.failures).toEqual([]);
    } finally { f.host.controllerFrames.delete(drop); await f.dispose(); }
  }, 20_000);

  test.each(['execution', 'service'] as const)('%s replies survive held application admission and partial socket drainage', async (family) => {
    const provider = model(async () => 'synthetic queued reply output');
    const f = await createNodeSessionOutputFixture(certificate);
    const lifetime = new AbortController();
    let pressure: ReturnType<typeof f.host.holdApplicationSocketAdmission> | undefined;
    let waiting: ReturnType<typeof spyOn<NodeSocketWriter, 'sendApplicationWhenWritable'>> | undefined;
    try {
      await f.recover();
      const output = await f.install(`synthetic-outbox-${family}`, { signal: lifetime.signal, emit() {} });
      const started = await f.start(output, '1789000000000096', `synthetic-outbox-${family}`, provider.configuration, 'synthetic input');
      expect(started.result).toEqual({ kind: 'dispatched' });
      await f.waitFor(output, (event) => event.type === 'run-ended');
      const parked = Promise.withResolvers<string>();
      const send = NodeSocketWriter.prototype.sendApplicationWhenWritable;
      waiting = spyOn(NodeSocketWriter.prototype, 'sendApplicationWhenWritable').mockImplementation(function (this: NodeSocketWriter, text, signal, validate) {
        parked.resolve(text);
        return send.call(this, text, signal, validate);
      });
      pressure = f.host.holdApplicationSocketAdmission();
      const reply = family === 'execution'
        ? f.controller.client.execution('synthetic-instance').call({ method: 'status', identity: started.identity }, f.signal)
        : f.controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' }, f.signal);
      const parkedFrame = parseNodeWorkerApplicationText(await withTimeout(parked.promise, 5000, () => 'Synthetic reply did not reach the socket outbox'));
      expect(parkedFrame).toMatchObject({ connectionId: f.connection.connectionId,
        type: family === 'execution' ? 'node-worker-execution' : 'node-worker-service-result' });
      if (parkedFrame?.type === 'node-worker-execution') expect(parseNodeExecutionReplyText(parkedFrame.payload)).toMatchObject({ result: { kind: 'status' } });
      else expect(parkedFrame).toMatchObject({ result: { kind: 'provider-auth-status' } });
      expect(f.controller.signal.aborted).toBe(false);
      pressure.drain(1024);
      expect(pressure.remainingBytes).toBeGreaterThan(0);
      expect(await reply).toMatchObject(family === 'execution' ? { kind: 'status', receipt: { phase: 'ended' } } : { kind: 'provider-auth-status' });
      expect(waiting).toHaveBeenCalledTimes(1);
      expect(f.controller.signal.aborted).toBe(false);
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      expect(f.failures).toEqual([]); expect(provider.requests).toHaveLength(1);
    } finally { waiting?.mockRestore(); pressure?.release(); lifetime.abort(); await f.dispose(); await provider.close(); }
  });

  test('a disconnected queued reply cannot reach the replacement physical connection', async () => {
    const provider = model(async () => 'synthetic reply replacement');
    const f = await createNodeSessionOutputFixture(certificate);
    const lifetime = new AbortController();
    let pressure: ReturnType<typeof f.host.holdApplicationSocketAdmission> | undefined;
    let waiting: ReturnType<typeof spyOn<NodeSocketWriter, 'sendApplicationWhenWritable'>> | undefined;
    try {
      await f.recover();
      const output = await f.install('synthetic-outbox-replacement', { signal: lifetime.signal, emit() {} });
      const started = await f.start(output, '1789000000000095', 'synthetic-outbox-replacement', provider.configuration, 'synthetic input');
      expect(started.result).toEqual({ kind: 'dispatched' });
      await f.waitFor(output, (event) => event.type === 'run-ended');
      const parked = Promise.withResolvers<string>();
      const send = NodeSocketWriter.prototype.sendApplicationWhenWritable;
      waiting = spyOn(NodeSocketWriter.prototype, 'sendApplicationWhenWritable').mockImplementation(function (this: NodeSocketWriter, text, signal, validate) {
        parked.resolve(text); return send.call(this, text, signal, validate);
      });
      pressure = f.host.holdApplicationSocketAdmission();
      const previousId = f.connection.connectionId;
      const reply = f.controller.client.execution('synthetic-instance').call({ method: 'status', identity: started.identity }, f.signal);
      const parkedFrame = parseNodeWorkerApplicationText(await withTimeout(parked.promise, 5000, () => 'Synthetic reply did not reach the socket outbox'));
      expect(parkedFrame).toMatchObject({ type: 'node-worker-execution', connectionId: previousId });
      await f.disconnect();
      expect(await reply).toEqual({ kind: 'unknown' });
      waiting.mockRestore(); waiting = undefined;
      const receivedConnections: number[] = [];
      f.host.controllerFrames.add((frame) => { if ('connectionId' in frame) receivedConnections.push(frame.connectionId); return true; });
      await f.reconnect(); await f.recover();
      pressure.release(); pressure = undefined;
      expect(f.connection.connectionId).toBeGreaterThan(previousId);
      expect(await f.controller.client.execution('synthetic-instance').call({ method: 'status', identity: started.identity }, f.signal))
        .toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
      expect(receivedConnections.length).toBeGreaterThan(0);
      expect(receivedConnections.every((id) => id === f.connection.connectionId)).toBe(true);
      expect(f.failures).toEqual([]); expect(provider.requests).toHaveLength(1);
    } finally { waiting?.mockRestore(); pressure?.release(); lifetime.abort(); await f.dispose(); await provider.close(); }
  });

  test('status replies cross both worker hops while ordinary socket admission is held', async () => {
    const provider = model(async () => 'synthetic reserve output');
    const f = await createNodeSessionOutputFixture(certificate);
    const lifetime = new AbortController();
    let pressure: { release(): void } | undefined;
    try {
      await f.recover();
      const output = await f.install('synthetic-reserve-output', { signal: lifetime.signal, emit() {} });
      const started = await f.start(output, '1789000000000098', 'synthetic-reserve-run', provider.configuration, 'synthetic input');
      expect(started.result).toEqual({ kind: 'dispatched' });
      await f.waitFor(output, (event) => event.type === 'run-ended');
      pressure = f.host.holdOrdinarySocketAdmission();
      expect(await f.controller.client.execution('synthetic-instance').call({ method: 'status', identity: started.identity }, f.signal))
        .toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
      expect(await f.controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' }, f.signal))
        .toMatchObject({ kind: 'provider-auth-status' });
      expect(f.controller.signal.aborted).toBe(false);
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      expect(f.failures).toEqual([]);
      expect(provider.requests).toHaveLength(1);
    } finally { pressure?.release(); lifetime.abort(); await f.dispose(); provider.close(); }
  });

  test('held output admission leaves both worker hops readable for service replies', async () => {
    const provider = model(async () => 'synthetic relay output '.repeat(12_000));
    const f = await createNodeSessionOutputFixture(certificate);
    let pressure: ReturnType<typeof f.host.holdOutputAdmission> | undefined;
    try {
      await f.recover();
      const output = await f.install('synthetic-held-relay', { signal: f.signal, emit() {} });
      pressure = f.host.holdOutputAdmission(64 * 1024);
      const starting = f.start(output, '1789000000000097', 'synthetic-relay-run', provider.configuration, 'synthetic input');
      void starting.catch(() => {});
      await withTimeout(pressure.blocked, 5000, () => 'Synthetic output did not reach socket admission');
      const status = f.controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' }, f.signal);
      expect(await withTimeout(status, 1000, () => 'Service reply was blocked behind output admission'))
        .toMatchObject({ kind: 'provider-auth-status' });
      expect(output.events.some((event) => event.type === 'rows')).toBe(false);
      expect(f.controller.signal.aborted).toBe(false);
      pressure.release(); pressure = undefined;
      expect((await starting).result).toEqual({ kind: 'dispatched' });
      await f.waitFor(output, (event) => event.type === 'run-ended');
      expect(f.failures).toEqual([]);
      expect(provider.requests).toHaveLength(1);
    } finally { pressure?.release(); await f.dispose(); provider.close(); }
  });

  test('sustained output ACKs and status RPCs do not allocate whole-socket drain waiters', async () => {
    const provider = model(async () => 'synthetic output');
    const f = await createNodeSessionOutputFixture(certificate);
    const lifetime = new AbortController();
    let drain: ReturnType<typeof spyOn<NodeSocketWriter, 'drained'>> | undefined;
    let acknowledgements: ReturnType<typeof spyOn<typeof f.controller.client, 'admitOutputAck'>> | undefined;
    try {
      await f.recover();
      const output = await f.install('synthetic-sustained-output', { signal: lifetime.signal, emit() {} });
      drain = spyOn(NodeSocketWriter.prototype, 'drained');
      acknowledgements = spyOn(f.controller.client, 'admitOutputAck');
      let nativeSession: Extract<(typeof output.events)[number], { type: 'session' }>['session'] | undefined;
      for (let index = 0; index < 129; index++) {
        const runId = `synthetic-sustained-${index}`;
        const started = await f.start(output, '1789000000000099', runId, provider.configuration, 'synthetic input', nativeSession);
        expect(started.result).toEqual({ kind: 'dispatched' });
        await f.waitFor(output, (event) => event.type === 'run-ended' && event.runId === runId);
        nativeSession ??= output.events.find((event) => event.type === 'session')?.session;
        expect(nativeSession).toBeDefined();
        expect(await f.controller.client.execution('synthetic-instance').call({ method: 'status', identity: started.identity }, f.signal))
          .toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
        expect(await f.controller.client.service.call({ method: 'provider-auth', instanceId: 'synthetic-instance', operation: 'status' }, f.signal))
          .toMatchObject({ kind: 'provider-auth-status' });
      }
      expect(acknowledgements.mock.calls.length).toBeGreaterThan(128);
      expect(drain).not.toHaveBeenCalled();
      expect(provider.requests).toHaveLength(129);
      expect(f.controller.signal.aborted).toBe(false);
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      expect(f.failures).toEqual([]);
    } finally {
      drain?.mockRestore(); acknowledgements?.mockRestore();
      lifetime.abort(); await f.dispose(); provider.close();
    }
  }, 90_000);

  test('lost ACKs and a mid-record disconnect preserve the same V5 sink and exact operation receipts', async () => {
    const large = '界'.repeat(40_000);
    const firstOutput = 'synthetic large output '.repeat(300_000) + 'synthetic end';
    const secondOutput = Promise.withResolvers<string>();
    const provider = model(async (index) => index === 1 ? firstOutput : secondOutput.promise);
    const f = await createNodeSessionOutputFixture(certificate);
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(f.host.storage, 'controller-ledger')));
    const chatId = '1789000000000001';
    ledger.initializeChat(chatId);
    const lease = ledger.openProducer(chatId, 'direct-anthropic-compatible');
    try {
      expect(f.host.coordinator.supervisor.status).toBe('recovering');
      await f.recover();
      const output = await f.install('synthetic-output', { signal: lease.signal, emit: (event) => lease.sink.publish(event) });
      f.setAcknowledgements(false);
      const prompt = 'synthetic input '.repeat(6000);
      const pressure = f.host.holdOutputAdmission(4 * 1024 * 1024);
      const starting = f.start(output, chatId, 'synthetic-first', provider.configuration, prompt);
      void starting.catch(() => {});
      try {
        await withTimeout(pressure.blocked, 5000, () => 'Synthetic large output did not reach socket admission');
        expect(ledger.currentRows(chatId).some((row) => row.kind === 'provider-row')).toBe(false);
        expect(f.controller.signal.aborted).toBe(false);
        expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      } finally { pressure.release(); }
      const first = await starting;
      expect(first.result).toEqual({ kind: 'dispatched' });
      await f.waitFor(output, (event) => event.type === 'run-ended' && event.runId === 'synthetic-first');
      const committed = ledger.currentRows(chatId);
      expect(committed.filter((row) => row.kind === 'provider-row')).toHaveLength(1);
      expect(Buffer.byteLength(firstOutput)).toBeGreaterThan(4 * 1024 * 1024);
      expect(JSON.stringify(committed).includes(firstOutput)).toBe(true);
      expect(provider.requests[0]).toMatchObject({ messages: [{ role: 'user', content: prompt }] });
      const authority = f.connection.lease.authoritySignal;
      await f.disconnect();
      expect(authority.aborted).toBe(false);
      await f.reconnect();
      f.setAcknowledgements(true);
      await f.recover();
      expect(f.connection.lease.authoritySignal).toBe(authority);
      expect(ledger.currentRows(chatId)).toEqual(committed);
      expect(f.receipts.get(first.identity.operationId)).toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
      expect(f.host.processes.size).toBe(1);

      const interrupted = Promise.withResolvers<void>();
      let closed: Promise<void> | null = null;
      const interrupt = (frame: NodeWorkerApplicationFrame) => {
        if (frame.type !== 'node-worker-output-delivery') return;
        const payload = parseNodeWorkerOutputText(frame.payload)!;
        if (payload.descriptor.byteLength < 64 * 1024) return;
        f.delivery.delete(interrupt);
        closed = f.disconnect();
        interrupted.resolve();
      };
      f.delivery.add(interrupt);
      const second = await f.start(output, chatId, 'synthetic-partial', provider.configuration, 'synthetic second input');
      expect(second.result).toEqual({ kind: 'dispatched' });
      secondOutput.resolve(large);
      await withTimeout(interrupted.promise, 10_000, () => 'Synthetic partial record did not arrive');
      await closed;
      expect(ledger.currentRows(chatId).filter((row) => row.kind === 'provider-row')).toHaveLength(1);
      await f.reconnect(); await f.recover();
      await f.waitFor(output, (event) => event.type === 'run-ended' && event.runId === 'synthetic-partial');
      const rows = ledger.currentRows(chatId).filter((row) => row.kind === 'provider-row');
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows[1]).includes(large)).toBe(true);
      expect(f.receipts.get(second.identity.operationId)).toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
      expect(provider.requests).toHaveLength(2);
      expect(f.host.processes.size).toBe(1);
      expect(lease.signal.aborted).toBe(false);
      expect(f.failures).toEqual([]);
    } finally { secondOutput.resolve('synthetic cleanup'); ledger.close(); await f.dispose(); await provider.close(); }
  }, 25_000);

  test('retirement produced offline arrives before recovery releases a sibling stream', async () => {
    const responding = Promise.withResolvers<string>();
    const requested = Promise.withResolvers<void>();
    const provider = model(async () => { requested.resolve(); return responding.promise; });
    const f = await createNodeSessionOutputFixture(certificate);
    const published: unknown[] = [];
    try {
      await f.recover();
      const output = await f.install('synthetic-pruned-output', { signal: f.signal, emit(event) { published.push(event); } });
      const sibling = await f.install('synthetic-sibling', { signal: f.signal, emit() { throw new Error('Unexpected synthetic sibling output'); } });
      const started = await f.start(output, '1789000000000002', 'synthetic-offline', provider.configuration, 'synthetic offline input');
      expect(started.result).toEqual({ kind: 'dispatched' });
      await requested.promise;
      await f.disconnect();
      const retired = Promise.withResolvers<void>();
      f.host.workerFrames.add((frame) => {
        if (frame.type === 'node-worker-output-retired' && frame.stream.streamId === output.stream.streamId) retired.resolve();
      });
      responding.resolve('x'.repeat(MAX_NODE_OUTPUT_BYTES));
      await withTimeout(retired.promise, 10_000, () => 'Synthetic offline retirement did not reach the logical owner');
      expect(output.retired).toBe(false);
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      await f.reconnect(); await f.recover();
      expect(output.retired).toBe(true);
      expect(sibling.retired).toBe(false);
      expect(f.ready).toBe(true);
      expect(f.host.coordinator.supervisor.status).toBe('online');
      expect(f.host.processes.size).toBe(1);
      expect(provider.requests).toHaveLength(1);
      expect(f.failures).toEqual([]);
    } finally { responding.resolve('synthetic cleanup'); await f.dispose(); await provider.close(); }
  }, 20_000);

  test('producer closure during a partial record retires its remote stream across reconnect without touching the replacement sink', async () => {
    const responding = Promise.withResolvers<string>();
    const provider = model(async (index) => index === 1 ? responding.promise : 'synthetic replacement output');
    const f = await createNodeSessionOutputFixture(certificate);
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(f.host.storage, 'controller-ledger')));
    const chatId = '1789000000000005';
    ledger.initializeChat(chatId);
    const view = ledger.currentView(chatId);
    const source = ledger.openProducer(chatId, 'direct-anthropic-compatible');
    try {
      await f.recover();
      const output = await f.install('synthetic-closing-source', { signal: source.signal, emit: (event) => source.sink.publish(event) });
      const partial = Promise.withResolvers<void>();
      let closed: Promise<void> | null = null;
      const interrupt = (frame: NodeWorkerApplicationFrame) => {
        if (frame.type !== 'node-worker-output-delivery' || parseNodeWorkerOutputText(frame.payload)!.descriptor.byteLength < 64 * 1024) return;
        f.delivery.delete(interrupt);
        closed = f.disconnect(); partial.resolve();
      };
      f.delivery.add(interrupt);
      expect((await f.start(output, chatId, 'synthetic-old-run', provider.configuration, 'synthetic old input')).result)
        .toEqual({ kind: 'dispatched' });
      responding.resolve('synthetic retired content '.repeat(6000));
      await withTimeout(partial.promise, 10_000, () => 'Synthetic source-close test did not reach partial delivery');
      await closed;
      source.close();
      expect(output.retired).toBe(true);
      expect(output.failures).toEqual([]);
      const replacement = ledger.openProducer(chatId, 'direct-anthropic-compatible');
      await f.reconnect(); await f.recover();
      expect(ledger.currentRows(chatId).filter((row) => row.kind === 'provider-row')).toEqual([]);
      const next = await f.install('synthetic-replacement-source', { signal: replacement.signal, emit: (event) => replacement.sink.publish(event) });
      expect((await f.start(next, chatId, 'synthetic-new-run', provider.configuration, 'synthetic new input')).result)
        .toEqual({ kind: 'dispatched' });
      await f.waitFor(next, (event) => event.type === 'run-ended');
      expect(ledger.currentRows(chatId).filter((row) => row.kind === 'provider-row'))
        .toMatchObject([{ message: { content: 'synthetic replacement output' } }]);
      expect(ledger.currentView(chatId)).toEqual(view);
      expect(replacement.signal.aborted).toBe(false);
      expect(f.host.processes.size).toBe(1);
      expect(provider.requests).toHaveLength(2);
      expect(output.failures).toEqual([]);
      expect(f.failures).toEqual([]);
    } finally { responding.resolve('synthetic cleanup'); ledger.close(); await f.dispose(); await provider.close(); }
  }, 20_000);

  test('an evicted record interrupted during delivery fails only its stream while the sibling recovers', async () => {
    const responding = Promise.withResolvers<string>();
    const provider = model(async () => responding.promise);
    const f = await createNodeSessionOutputFixture(certificate, { replay: { ...DEFAULT_NODE_REPLAY, maxBytes: 4096 } });
    try {
      await f.recover();
      const output = await f.install('synthetic-cache-gap', { signal: f.signal, emit() {} });
      const sibling = await f.install('synthetic-unaffected', { signal: f.signal, emit() { throw new Error('Unexpected synthetic sibling output'); } });
      const interrupted = Promise.withResolvers<void>();
      let closed: Promise<void> | null = null;
      const interrupt = (frame: NodeWorkerApplicationFrame) => {
        if (frame.type !== 'node-worker-output-delivery' || parseNodeWorkerOutputText(frame.payload)!.descriptor.byteLength < 64 * 1024) return;
        f.delivery.delete(interrupt);
        closed = f.disconnect(); interrupted.resolve();
      };
      f.delivery.add(interrupt);
      const started = await f.start(output, '1789000000000003', 'synthetic-gap', provider.configuration, 'synthetic input');
      expect(started.result).toEqual({ kind: 'dispatched' });
      responding.resolve('x'.repeat(128 * 1024));
      await withTimeout(interrupted.promise, 10_000, () => 'Synthetic eviction test did not reach partial delivery');
      await closed;
      await f.reconnect(); await f.recover();
      expect(output.retired).toBe(true);
      expect(sibling.retired).toBe(false);
      expect(f.ready).toBe(true);
      expect(f.failures).toEqual([]);
      expect(f.host.processes.size).toBe(1);
    } finally { responding.resolve('synthetic cleanup'); await f.dispose(); await provider.close(); }
  }, 20_000);

  test('a lost dispatch reply stays unknown until exact receipt reconciliation and never starts the provider twice', async () => {
    const responding = Promise.withResolvers<string>();
    const requested = Promise.withResolvers<void>();
    const provider = model(async () => { requested.resolve(); return responding.promise; });
    const f = await createNodeSessionOutputFixture(certificate);
    try {
      await f.recover();
      const output = await f.install('synthetic-unknown-dispatch', { signal: f.signal, emit() {} });
      let closed: Promise<void> | null = null;
      const dropDispatch = (frame: NodeWorkerApplicationFrame) => {
        if (frame.type !== 'node-worker-execution' || parseNodeExecutionReplyText(frame.payload)?.result.kind !== 'dispatched') return true;
        f.host.controllerFrames.delete(dropDispatch);
        closed = f.disconnect(); return false;
      };
      f.host.controllerFrames.add(dropDispatch);
      const started = await f.start(output, '1789000000000004', 'synthetic-lost-reply', provider.configuration, 'synthetic input');
      expect(started.result).toEqual({ kind: 'unknown' });
      expect(closed).not.toBeNull(); await closed;
      await withTimeout(requested.promise, 5000, () => 'Synthetic provider was not dispatched');
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      await f.reconnect(); await f.recover();
      expect(f.receipts.get(started.identity.operationId)).toMatchObject({ kind: 'status', receipt: { phase: 'dispatched' } });
      responding.resolve('synthetic recovered output');
      await f.waitFor(output, (event) => event.type === 'run-ended');
      expect(provider.requests).toHaveLength(1);
      expect(f.host.processes.size).toBe(1);
      expect(f.failures).toEqual([]);
    } finally { responding.resolve('synthetic cleanup'); await f.dispose(); await provider.close(); }
  }, 20_000);

  test('Stop commits during a partition and recovery aborts only its captured operation before reopening admission', async () => {
    const firstResponse = Promise.withResolvers<string>(); const secondResponse = Promise.withResolvers<string>();
    const firstRequested = Promise.withResolvers<void>(); const secondRequested = Promise.withResolvers<void>();
    const provider = model(async (index) => {
      if (index === 1) { firstRequested.resolve(); return firstResponse.promise; }
      secondRequested.resolve(); return secondResponse.promise;
    });
    const f = await createNodeSessionOutputFixture(certificate, { maxOperations: 2 });
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(f.host.storage, 'controller-ledger')));
    const chatId = '1789000000000006'; const siblingId = '1789000000000007';
    for (const id of [chatId, siblingId]) ledger.initializeChat(id);
    const firstSource = ledger.openProducer(chatId, 'direct-anthropic-compatible');
    const secondSource = ledger.openProducer(siblingId, 'direct-anthropic-compatible');
    let abortReplies = 0;
    f.host.controllerFrames.add((frame) => {
      if (frame.type === 'node-worker-execution' && parseNodeExecutionReplyText(frame.payload)?.result.kind === 'abort-result') abortReplies++;
      return true;
    });
    try {
      await f.recover();
      const first = await f.install('synthetic-interrupted', { signal: firstSource.signal, emit: (event) => firstSource.sink.publish(event) });
      const second = await f.install('synthetic-running-sibling', { signal: secondSource.signal, emit: (event) => secondSource.sink.publish(event) });
      ledger.beginRun(chatId, 'synthetic-interrupted-run');
      ledger.beginRun(siblingId, 'synthetic-sibling-run');
      const stopped = await f.start(first, chatId, 'synthetic-interrupted-run', provider.configuration, 'synthetic interrupt input');
      await withTimeout(firstRequested.promise, 5000, () => 'Synthetic first provider request did not start');
      const sibling = await f.start(second, siblingId, 'synthetic-sibling-run', provider.configuration, 'synthetic sibling input');
      await withTimeout(secondRequested.promise, 5000, () => 'Synthetic sibling provider request did not start');
      await f.disconnect();
      ledger.interruptRun(chatId);
      expect(await f.interrupt(stopped.identity)).toBe(false);
      expect(abortReplies).toBe(0);
      expect(ledger.activeRunId(chatId)).toBeNull();
      expect(ledger.currentRows(chatId)).toContainEqual(expect.objectContaining({ kind: 'run-ended', outcome: 'interrupted' }));
      await f.reconnect(); await f.recover();
      expect(f.ready).toBe(true);
      expect(abortReplies).toBe(1);
      expect(f.receipts.get(stopped.identity.operationId)).toMatchObject({ kind: 'status', receipt: { abort: 'requested' } });
      expect(f.receipts.get(sibling.identity.operationId)).toMatchObject({ kind: 'status', receipt: { phase: 'dispatched', abort: null } });
      expect(ledger.activeRunId(chatId)).toBeNull();
      expect(ledger.activeRunId(siblingId)).toBe('synthetic-sibling-run');
      secondResponse.resolve('synthetic sibling survived');
      await f.waitFor(second, (event) => event.type === 'run-ended');
      expect(ledger.currentRows(siblingId).filter((row) => row.kind === 'provider-row'))
        .toMatchObject([{ message: { content: 'synthetic sibling survived' } }]);
      expect(provider.requests).toHaveLength(2);
      expect(f.host.processes.size).toBe(1);
      expect(f.failures).toEqual([]);
    } finally {
      firstResponse.resolve('synthetic cleanup'); secondResponse.resolve('synthetic cleanup');
      ledger.close(); await f.dispose(); await provider.close();
    }
  }, 20_000);
});
