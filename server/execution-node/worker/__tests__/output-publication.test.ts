import { expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage } from '../../../../common/chat-types.js';
import { parseNodeOutputText } from '@garcon/server-agent-interface';
import { TranscriptLedgerService } from '../../../ledger/service.js';
import { TranscriptLedgerStore } from '../../../ledger/store.js';
import { OrderedPublicationIngress } from '../../../execution-nodes/publication-ingress.js';
import type { NodeOutputPermissionHandles } from '../../output-encoder.js';
import { DEFAULT_NODE_REPLAY } from '../../replay-cache.js';
import { NodeWorkerOutputAssembler } from '../output-assembler.js';
import { NodeOutputAssemblyBudget } from '../output-budget.js';
import { NodeWorkerOutputDelivery, type NodeOutputDeliveryAttempt } from '../output-delivery.js';
import { parseNodeWorkerOutputDeliveryText } from '../output-delivery-protocol.js';
import { NodeWorkerOutputDeliveryReceiver } from '../output-delivery-receiver.js';
import { NodeWorkerOutputDeliverySender } from '../output-delivery-sender.js';
import { NodeWorkerOutputPort } from '../output-port.js';
import { parseNodeWorkerOutputText } from '../output-protocol.js';
import { parseNodeWorkerOutputRetirementText } from '../output-retirement.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NodeWorkerWriter } from '../writer.js';
import { session, tick } from './lifecycle-fixture.js';

const stream = { ...session, streamId: 'synthetic-stream' };
const instanceId = 'synthetic-instance';
const at = '2026-09-11T00:00:00.000Z';

test('instance output crosses session replay and physical assembly into real V5 once despite a lost ACK and a mid-record reconnect', async () => {
  const directory = await mkdtemp(join(homedir(), 'garcon-output-publication-'));
  const lifetime = new AbortController();
  const failed = mock((_error: unknown) => {});
  let requests = 0;
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory), {
    chatIdRequests: { request() { requests += 1; expect(ledger.currentRows('synthetic-chat')).toHaveLength(3); } },
  });
  ledger.initializeChat('synthetic-chat');
  const lease = ledger.openProducer('synthetic-chat', 'synthetic');
  const ingress = new OrderedPublicationIngress({ stream, sink: lease.sink,
    permission() { throw new Error('Unexpected synthetic permission'); } });
  const delivery = new NodeWorkerOutputDelivery({ session, instanceIds: new Set([instanceId]), signal: lifetime.signal, replay: DEFAULT_NODE_REPLAY,
    now: () => 0, validate() {}, disconnected: failed, failed });
  const receiver = new NodeWorkerOutputDeliveryReceiver({ session, signal: lifetime.signal, instanceIds: new Set([instanceId]),
    budget: new NodeOutputAssemblyBudget(32 * 1024 * 1024), now: () => 0, validate() {}, failed });
  const assembler = new NodeWorkerOutputAssembler({ session, signal: lifetime.signal, instanceIds: new Set([instanceId]),
    now: () => 0, validate() {}, failed });
  let current: NodeOutputDeliveryAttempt;
  let acknowledge = false;
  const accepted: string[] = [];
  const published: string[] = [];
  delivery.install(instanceId, stream, lifetime.signal, failed);
  receiver.install(instanceId, stream, lifetime.signal, (serialized) => {
    published.push(serialized);
    const result = ingress.receive(parseNodeOutputText(serialized)!);
    expect(result.kind).toBe('ack');
    if (acknowledge && result.kind === 'ack') delivery.acknowledge(current, result.ack);
  }, failed);
  assembler.install(instanceId, stream, lifetime.signal, (serialized, sequence) => {
    accepted.push(serialized); delivery.accept(stream, serialized, sequence);
  }, failed);
  const instanceWriter = new NodeWorkerWriter({ write(bytes) {
    const text = Buffer.from(bytes.subarray(4)).toString();
    if (parseNodeWorkerOutputRetirementText(text)) assembler.receiveRetirement(instanceId, text);
    else assembler.receive(instanceId, text);
    return Promise.resolve();
  }, close() {} }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed });
  const held = Promise.withResolvers<void>();
  let holdNext = false;
  let heldChunk: string | null = null;
  const sessionWriter = new NodeWorkerWriter({ write(bytes) {
    const text = Buffer.from(bytes.subarray(4)).toString();
    receiver.receive(text);
    if (holdNext) { holdNext = false; heldChunk = text; return held.promise; }
    return Promise.resolve();
  }, close() { held.resolve(); } }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed });
  const port = new NodeWorkerOutputPort(instanceWriter, { session, instanceId, signal: lifetime.signal, now: () => 0, validate() {}, failed });
  const permissions = { createHandle() { throw new Error('Unexpected permission'); }, register() {}, retire() {} } satisfies NodeOutputPermissionHandles;
  const output = port.install(stream, lifetime.signal, permissions, failed);
  const begin = (connectionId: number, afterSequence: number) => {
    const sender = new NodeWorkerOutputDeliverySender(sessionWriter, { session, connectionId, signal: lifetime.signal, validate() {} });
    current = delivery.beginRecovery((record, attempt) => sender.send(record, attempt));
    const receiving = receiver.begin(connectionId, current.generation, [{ stream, afterSequence }], lifetime.signal);
    return { sending: current, receiving };
  };
  try {
    const initial = begin(1, 0);
    await delivery.replay(initial.sending, [{ stream, afterSequence: 0 }]);
    expect(delivery.resumeLive(initial.sending)).toBe(true);
    output.emit({ type: 'rows', rows: [
      { message: new AssistantMessage(at, 'synthetic first') },
      { message: new AssistantMessage(at, '<garcon-get-chat-id />\nsynthetic second') },
    ] });
    expect(accepted).toHaveLength(0);
    await tick();
    const committed = ledger.currentRows('synthetic-chat');
    expect(committed).toHaveLength(3); expect(requests).toBe(1);
    expect(delivery.retainedBytes).toBeGreaterThan(0);
    delivery.suspend(initial.sending); receiver.suspend(initial.receiving);
    const redelivery = begin(2, 0);
    acknowledge = true;
    await delivery.replay(redelivery.sending, [{ stream, afterSequence: 0 }]);
    expect(delivery.resumeLive(redelivery.sending)).toBe(true);
    expect(ledger.currentRows('synthetic-chat')).toEqual(committed); expect(requests).toBe(1);
    expect(published).toEqual([accepted[0]!, accepted[0]!]); expect(delivery.retainedBytes).toBe(0);

    holdNext = true;
    output.emit({ type: 'rows', rows: [{ message: new AssistantMessage(at, '界'.repeat(30_000)) }] });
    await tick(); expect(heldChunk).not.toBeNull();
    expect(parseNodeWorkerOutputText(parseNodeWorkerOutputDeliveryText(heldChunk!)!.payload)!.chunk.offset).toBe(0);
    expect(ledger.currentRows('synthetic-chat')).toEqual(committed);
    delivery.suspend(redelivery.sending); receiver.suspend(redelivery.receiving);
    output.emit({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'synthetic disconnected suffix') }] });
    await tick(); expect(accepted).toHaveLength(3);
    const recovery = begin(3, ingress.acceptedSequence);
    const replay = delivery.replay(recovery.sending, [{ stream, afterSequence: 1 }]);
    expect(receiver.receive(heldChunk!)).toBe('retired');
    held.resolve();
    expect(await replay).toEqual([{ type: 'node-replay-ready', stream, afterSequence: 1, throughSequence: 3 }]);
    expect(delivery.resumeLive(recovery.sending)).toBe(true);
    expect(ledger.currentRows('synthetic-chat')).toHaveLength(5);
    expect(published).toEqual([accepted[0]!, ...accepted]);
    expect(requests).toBe(1); expect(ingress.acceptedSequence).toBe(3);
    expect(delivery.retainedBytes).toBe(0); expect(assembler.bufferedBytes).toBe(0);
    expect(port.bufferedBytes).toBe(0); expect(failed).not.toHaveBeenCalled();
  } finally {
    lifetime.abort(); held.resolve(); port.close(); instanceWriter.close(); sessionWriter.close(); assembler.close(); delivery.close(); receiver.close();
    ledger.close(); await rm(directory, { recursive: true, force: true });
  }
});
