import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_NODE_OUTPUT_BYTES, NODE_WIRE_VERSION, parseNodeOutputText, type NodeOutputFrame } from '../../../server-agents/interface/src/index.js';
import { DEFAULT_NODE_REPLAY } from '../../../server/execution-node/replay-cache.js';
import { NodeWorkerPeer } from '../../../server/execution-node/worker/peer.js';
import { createNodeWorkerWorkingDirectory, NODE_WORKER_BUN_OPTIONS, nodeWorkerCommand } from '../../../server/execution-node/worker/launch.js';
import { NodeWorkerOutputDeliveryReceiver } from '../../../server/execution-node/worker/output-delivery-receiver.js';
import { NodeOutputAssemblyBudget } from '../../../server/execution-node/worker/output-budget.js';
import { parseNodeWorkerOutputText } from '../../../server/execution-node/worker/output-protocol.js';
import { NodeBulkChannel } from '../../../server/execution-nodes/transport/bulk-channel.js';
import { serializeNodeBulkFrame } from '../../../server/execution-nodes/transport/bulk-channel-wire.js';
import { serializeNodeExecutionBody } from '../../../server/execution-nodes/transport/execution-body-wire.js';
import { MAX_NODE_BULK_CHUNK_BYTES } from '../../../server/execution-nodes/transport/bulk-wire.js';
import { OrderedPublicationIngress } from '../../../server/execution-nodes/publication-ingress.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { withTimeout } from '../../support/deferred.js';

test('real instance output and bulk input survive a mid-record reconnect and publish once through V5', async () => {
  const storage = await mkdtemp(path.join(homedir(), 'garcon-worker-output-'));
  const directory = await createNodeWorkerWorkingDirectory(storage);
  const lifetime = new AbortController();
  const failed = mock((_error: unknown) => {});
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  const instanceId = 'synthetic-instance'; const stream = { ...session, streamId: 'synthetic-stream' };
  const large = '界'.repeat(Math.floor((MAX_NODE_OUTPUT_BYTES - 8192) / 3));
  const reconnectOutput = '界'.repeat(30_000);
  const responses = ['synthetic first', reconnectOutput, large];
  const requests: unknown[] = [];
  const model = Bun.serve({ hostname: '0.0.0.0', port: 0, async fetch(request) {
    expect(request.headers.get('x-api-key')).toBe('synthetic-credential');
    requests.push(await request.json());
    const content = responses[requests.length - 1]!;
    const events = [
      { type: 'message_start', message: { id: `synthetic-${requests.length}`, type: 'message', role: 'assistant', model: 'synthetic-model',
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
  const child = Bun.spawn(nodeWorkerCommand('session'), { cwd: directory.path,
    env: { PATH: '/usr/bin:/bin', BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', timeout: 40_000 });
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(storage, 'ledger')));
  ledger.initializeChat('1789000000000001');
  const lease = ledger.openProducer('1789000000000001', 'direct-anthropic-compatible');
  const ingress = new OrderedPublicationIngress({ stream, sink: lease.sink, permission() { throw new Error('Unexpected permission'); } });
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session, instanceIds: new Set([instanceId]), signal: lifetime.signal,
    budget: new NodeOutputAssemblyBudget(32 * 1024 * 1024), now: () => performance.now(), validate() {}, failed });
  let connectionId = 1; let generation = 0; let physical = new AbortController(); let acknowledge = false; let interruptChunk = false;
  const interrupted = Promise.withResolvers<void>();
  const terminal = new Map<string, PromiseWithResolvers<void>>();
  const frames: NodeOutputFrame[] = [];
  const serializedSizes: number[] = [];
  let bulk: NodeBulkChannel;
  let disconnect: Promise<void> | null = null;
  let deliveryChunks = 0;
  const peer = new NodeWorkerPeer(child, { role: 'session', signal: lifetime.signal, validate() {}, failed,
    received(frame, text) {
      if (frame.type === 'node-worker-bulk') { bulk.receive(frame.payload); return; }
      if (frame.type === 'node-worker-output-retired') { receiver.receiveRetirement(text); return; }
      if (frame.type !== 'node-worker-output-delivery') throw new Error('Unexpected worker output');
      deliveryChunks++;
      receiver.receive(text);
      const payload = parseNodeWorkerOutputText(frame.payload)!;
      if (interruptChunk && payload.descriptor.byteLength > MAX_NODE_BULK_CHUNK_BYTES) {
        interruptChunk = false;
        physical.abort(); disconnect = peer.disconnect(connectionId);
        interrupted.resolve();
      }
    } });
  receiver.install(instanceId, stream, lifetime.signal, (text) => {
    const frame = parseNodeOutputText(text)!; frames.push(frame); serializedSizes.push(Buffer.byteLength(text));
    const result = ingress.receive(frame); expect(result.kind).toBe('ack');
    if (acknowledge && result.kind === 'ack') void peer.forward({ type: 'node-worker-output-ack', version: NODE_WIRE_VERSION,
      connectionId, generation, ack: result.ack }, physical.signal).drained.catch(failed);
    if (frame.event.type === 'run-ended') terminal.get(frame.event.runId)?.resolve();
  }, failed);
  const makeBulk = () => {
    const capturedId = connectionId; const signal = physical.signal;
    const forward = (payload: string, caller = signal) => peer.forward({ type: 'node-worker-bulk', version: NODE_WIRE_VERSION,
      session, connectionId: capturedId, instanceId, payload }, caller);
    return new NodeBulkChannel({ send(payload) { forward(payload); return true; },
      async sendWhenWritable(payload, caller, validate) { validate?.(); await forward(payload, caller).drained; },
      async writable(caller) { caller.throwIfAborted(); }, close() {} },
    { append() { throw new Error('Unexpected incoming body'); }, complete() { throw new Error('Unexpected incoming body'); }, cancel() {} },
    { session, signal, validate() { signal.throwIfAborted(); } });
  };
  const recover = async (afterSequence: number) => {
    const service = peer.service(connectionId);
    const begin = await service.call({ method: 'begin-output-recovery' }, physical.signal);
    if (begin.kind !== 'output-recovery') throw new Error(`Recovery failed: ${JSON.stringify(begin)}`);
    generation = begin.generation;
    receiver.begin(connectionId, generation, [{ stream, afterSequence }], physical.signal);
    for (let round = 0; round < 8; round++) {
      const replay = await service.call({ method: 'replay-output', generation, cursors: [{ stream, afterSequence }] }, physical.signal);
      expect(replay.kind).toBe('output-replayed');
      const resumed = await service.call({ method: 'resume-output', generation }, physical.signal);
      if (resumed.kind === 'output-live' && resumed.live) return;
      afterSequence = ingress.acceptedSequence;
    }
    throw new Error('Recovery failed to catch up');
  };
  const start = async (runId: string, prompt: string) => {
    terminal.set(runId, Promise.withResolvers<void>());
    const client = peer.execution(instanceId, connectionId);
    const prepared = await client.call({ method: 'prepare', location: { nodeId: 'synthetic-node', instanceId, workspaceId: 'synthetic-workspace' },
      request: { kind: 'start', chatId: '1789000000000001', runId, configuration: { model: 'synthetic-model', settings: null, thinkingMode: 'none',
        endpoint: { credential: 'synthetic-credential', selection: { apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint',
          providerLabel: 'Synthetic', protocol: 'anthropic-messages', model: 'synthetic-model', isLocal: true,
          baseUrl: `http://127.0.0.1:${model.port}`, capabilities: null, headers: {} } } } } }, physical.signal);
    if (prepared.kind !== 'prepared') throw new Error(`Preparation failed: ${JSON.stringify(prepared)}`);
    const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt, attachments: [], carriedContext: null } });
    const reserved = await peer.service(connectionId).call({ method: 'reserve-body', instanceId, identity: prepared.ticket.identity,
      kind: 'execution', controlId: null, descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, physical.signal);
    if (reserved.kind !== 'body-reserved') throw new Error(`Reservation failed: ${JSON.stringify(reserved)}`);
    for (let offset = 0; offset < bytes.length; offset += MAX_NODE_BULK_CHUNK_BYTES) await bulk.sendChunk(serializeNodeBulkFrame({
      type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer: reserved.transfer, offset,
      data: Buffer.from(bytes.subarray(offset, offset + MAX_NODE_BULK_CHUNK_BYTES)).toString('base64') }), physical.signal);
    await bulk.complete(reserved.transfer, physical.signal);
    expect(await client.call({ method: 'dispatch', identity: prepared.ticket.identity, stream, body: reserved.transfer }, physical.signal))
      .toEqual({ kind: 'dispatched' });
    return prepared.ticket;
  };
  const waitTerminal = (runId: string) => withTimeout(terminal.get(runId)!.promise, 15_000,
    () => `Missing ${runId} terminal; failures=${failed.mock.calls.length}, frames=${frames.length}`);
  try {
    await peer.hello;
    await peer.configure(session, 1, { role: 'session', nodeId: 'synthetic-node', storageDirectory: storage,
      instances: [{ id: instanceId, agentId: 'direct-anthropic-compatible', label: 'Synthetic', homeDirectory: path.join(storage, 'instance'),
        environment: {}, workspaceIds: ['synthetic-workspace'], maxOperations: 1 }],
      workspaces: [{ id: 'synthetic-workspace', projectPath: storage }], replay: DEFAULT_NODE_REPLAY });
    await peer.admit(1); bulk = makeBulk();
    expect(await peer.service(1).call({ method: 'install-output', instanceId, stream }, physical.signal)).toMatchObject({ kind: 'output-installed' });
    await recover(0);
    const prompt = 'synthetic input '.repeat(6000);
    await start('synthetic-first', prompt); await waitTerminal('synthetic-first');
    expect(requests[0]).toMatchObject({ messages: [{ role: 'user', content: prompt }] });
    const before = ledger.currentRows('1789000000000001');
    await peer.disconnect(1); physical.abort(); connectionId = 2; physical = new AbortController();
    await peer.attach(2); bulk = makeBulk(); acknowledge = true;
    await recover(0); expect(ledger.currentRows('1789000000000001')).toEqual(before);
    await peer.admit(2); interruptChunk = true;
    const second = await start('synthetic-reconnect', 'synthetic reconnect');
    await withTimeout(interrupted.promise, 15_000, () => `No partial output reached the coordinator; requests=${requests.length}, failures=${failed.mock.calls.map(([error]) => String(error))}, events=${JSON.stringify(frames.map((frame) => frame.event.type === 'run-ended' ? frame.event : frame.event.type))}`); await disconnect;
    expect(ledger.currentRows('1789000000000001').filter((row) => row.kind === 'provider-row')).toHaveLength(1);
    const cursor = ingress.acceptedSequence;
    connectionId = 3; physical = new AbortController(); await peer.attach(3); bulk = makeBulk();
    await recover(cursor); await waitTerminal('synthetic-reconnect');
    const rows = ledger.currentRows('1789000000000001').filter((row) => row.kind === 'provider-row');
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[1])).toContain(reconnectOutput);
    expect(await peer.execution(instanceId, 3).call({ method: 'status', identity: second.identity }, physical.signal))
      .toMatchObject({ kind: 'status', receipt: { phase: 'ended' } });
    await peer.admit(3);
    const beforeMaximum = frames.length;
    await start('synthetic-maximum', 'synthetic maximum'); await waitTerminal('synthetic-maximum');
    const completed = ledger.currentRows('1789000000000001').filter((row) => row.kind === 'provider-row');
    expect(completed).toHaveLength(3); expect(JSON.stringify(completed[2])).toContain(large);
    const maximumSizes = serializedSizes.slice(beforeMaximum).filter((size) => size > 12 * 1024 * 1024);
    expect(maximumSizes).toHaveLength(2);
    for (const size of maximumSizes) expect(size).toBeLessThanOrEqual(MAX_NODE_OUTPUT_BYTES);
    const combinedBytes = maximumSizes.reduce((sum, size) => sum + size, 0);
    expect(combinedBytes).toBeGreaterThan(24 * 1024 * 1024);
    expect(combinedBytes).toBeLessThanOrEqual(2 * MAX_NODE_OUTPUT_BYTES);
    expect(deliveryChunks).toBeGreaterThan(256);
    expect(requests).toHaveLength(3); expect(failed).not.toHaveBeenCalled();
  } finally {
    physical.abort(); lifetime.abort(); receiver.close(); peer.closeInput(); ledger.close();
    await child.exited; await model.stop(true); await rm(storage, { recursive: true, force: true });
  }
}, 45_000);
