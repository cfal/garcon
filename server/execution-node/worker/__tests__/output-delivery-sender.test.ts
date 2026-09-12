import { expect, test } from 'bun:test';
import { NODE_WIRE_VERSION, serializeNodeOutputFrame } from '@garcon/server-agent-interface';
import { chunkNodeWorkerOutput, parseNodeWorkerOutputText } from '../output-protocol.js';
import { MAX_NODE_WORKER_DELIVERY_CHUNK_BYTES, parseNodeWorkerOutputDeliveryText, serializeNodeWorkerOutputDelivery } from '../output-delivery-protocol.js';
import { NodeWorkerOutputDeliverySender } from '../output-delivery-sender.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NodeWorkerWriter } from '../writer.js';
import { session, tick } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-stream' };
const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1,
  event: { type: 'notice', runId: 'synthetic-run', content: '界'.repeat(30_000) } });

function fixture() {
  const lifetime = new AbortController();
  const streamLife = new AbortController();
  const attempts = [new AbortController(), new AbortController()];
  const written: { text: string; finished: PromiseWithResolvers<void> }[] = [];
  const writer = new NodeWorkerWriter({ write(bytes) {
    const finished = Promise.withResolvers<void>(); written.push({ text: Buffer.from(bytes.subarray(4)).toString(), finished }); return finished.promise;
  }, close() { for (const write of written) write.finished.resolve(); } }, {
    ...NODE_WORKER_WRITER_LIMITS, signal: new AbortController().signal, failed() {}, scheduleTimeout: () => ({ cancel() {} }),
  });
  const sender = new NodeWorkerOutputDeliverySender(writer, { session, connectionId: 2, signal: lifetime.signal, validate() {} });
  const record = { instanceId: 'synthetic-instance', stream, sequence: 1, serialized, signal: streamLife.signal };
  const tokens = attempts.map((value, index) => ({ generation: index + 1, signal: value.signal }));
  return { lifetime, streamLife, attempts, written, writer, sender, record, tokens };
}

test('delivery envelopes require exact session, physical connection and recovery-attempt fields', () => {
  const payload = chunkNodeWorkerOutput('synthetic-instance', serialized)[0]!;
  const frame = { type: 'node-worker-output-delivery', version: NODE_WIRE_VERSION, session, connectionId: 1, generation: 1, payload } as const;
  expect(parseNodeWorkerOutputDeliveryText(serializeNodeWorkerOutputDelivery(frame))).toEqual(frame);
  for (const bad of [
    { ...frame, extra: true }, { ...frame, generation: 0 }, { ...frame, generation: 1.5 }, { ...frame, connectionId: 0 },
    { ...frame, version: 2 }, { ...frame, connectionId: 1.5 }, { ...frame, payload: '{}' },
    { ...frame, session: { ...session, logicalSessionId: 'foreign' } }, { ...frame, payload: JSON.parse(payload) },
  ]) expect(parseNodeWorkerOutputDeliveryText(JSON.stringify(bad))).toBeNull();
  expect(parseNodeWorkerOutputDeliveryText(' '.repeat(MAX_NODE_WORKER_DELIVERY_CHUNK_BYTES + 1))).toBeNull();
});

test('session output chunks retain exact bytes and one physical attempt while yielding to lifecycle writes', async () => {
  const f = fixture();
  try {
    const sent = f.sender.send(f.record, f.tokens[0]!); await tick();
    expect(f.written).toHaveLength(1);
    const pulse = f.writer.send('synthetic pulse', 'control');
    f.written[0]!.finished.resolve(); await tick();
    expect(f.written[1]!.text).toBe('synthetic pulse');
    f.written[1]!.finished.resolve(); await pulse; await tick();
    expect(f.written).toHaveLength(3);
    f.written[2]!.finished.resolve(); await sent;
    const envelopes = [f.written[0]!, f.written[2]!].map(({ text }) => parseNodeWorkerOutputDeliveryText(text)!);
    for (const envelope of envelopes) expect(envelope).toMatchObject({ session, connectionId: 2, generation: f.tokens[0]!.generation });
    const bytes = Buffer.concat(envelopes.map((frame) => Buffer.from(parseNodeWorkerOutputText(frame.payload)!.chunk.data, 'base64')));
    expect(bytes.toString()).toBe(serialized);
    expect(f.writer.bufferedBytes).toBe(0);
  } finally { f.writer.close(); }
});

test.each(['stream', 'attempt', 'connection'] as const)('%s cancellation stops the old record after its current native chunk', async (cause) => {
  const f = fixture();
  try {
    const sent = f.sender.send(f.record, f.tokens[0]!); const result = sent.catch((error: unknown) => error); await tick();
    if (cause === 'stream') f.streamLife.abort();
    else if (cause === 'attempt') f.attempts[0]!.abort(); else f.lifetime.abort();
    expect(await result).toBeInstanceOf(Error);
    const held = f.writer.bufferedBytes;
    expect(held).toBeGreaterThan(0); expect(f.written).toHaveLength(1);
    f.written[0]!.finished.resolve(); await tick();
    expect(f.written).toHaveLength(1); expect(f.writer.bufferedBytes).toBe(0);
  } finally { f.writer.close(); }
});

test('a synchronously superseded recovery attempt writes no chunks before the new attempt', async () => {
  const f = fixture();
  try {
    const old = f.sender.send(f.record, f.tokens[0]!).catch((error: unknown) => error);
    f.attempts[0]!.abort();
    const current = f.sender.send(f.record, f.tokens[1]!); await tick();
    expect(await old).toBeInstanceOf(Error);
    expect(f.written).toHaveLength(1);
    expect(parseNodeWorkerOutputDeliveryText(f.written[0]!.text)!.generation).toBe(f.tokens[1]!.generation);
    f.written[0]!.finished.resolve(); await tick(); f.written[1]!.finished.resolve(); await current;
  } finally { f.writer.close(); }
});
