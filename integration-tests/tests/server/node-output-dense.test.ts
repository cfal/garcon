import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../../common/chat-types.js';
import { MAX_NODE_OUTPUT_BYTES, parseNodeOutputText, type AgentProducerEvent } from '../../../server-agents/interface/src/index.js';
import { NodeOutputEncoder } from '../../../server/execution-node/output-encoder.js';
import { OrderedPublicationIngress } from '../../../server/execution-nodes/publication-ingress.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';

test('dense output accepted by local V5 is preserved through node encoding and deduplicated controller publication', async () => {
  const directory = await mkdtemp(path.join(homedir(), 'garcon-dense-output-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory));
  const metadata = { synthetic: Array.from({ length: 300_000 }, () => 0) };
  const event: AgentProducerEvent = { type: 'rows', rows: [{
    message: new AssistantMessage('2026-09-12T00:00:00.000Z', 'synthetic content'),
    providerMeta: metadata,
  }] };
  try {
    const localChat = '1789000000000001';
    const remoteChat = '1789000000000002';
    ledger.initializeChat(localChat); ledger.initializeChat(remoteChat);
    ledger.openProducer(localChat, 'synthetic').sink.publish(event);
    const local = ledger.currentRows(localChat);
    expect(local).toHaveLength(1);
    const stream = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node',
      logicalSessionId: 'synthetic-session', streamId: 'synthetic-stream' };
    const ingress = new OrderedPublicationIngress({ stream, sink: ledger.openProducer(remoteChat, 'synthetic').sink,
      permission() { throw new Error('Unexpected permission'); } });
    const records: string[] = [];
    const failures: unknown[] = [];
    const encoder = new NodeOutputEncoder({ identity: stream,
      permissionHandles: { createHandle() { throw new Error('Unexpected permission'); }, register() {}, retire() {} },
      accept(text) { records.push(text); }, retire() {}, onOutputFailure(error) { failures.push(error); } });
    encoder.emit(event);
    expect(records).toHaveLength(1);
    expect(Buffer.byteLength(records[0]!)).toBeLessThan(MAX_NODE_OUTPUT_BYTES);
    metadata.synthetic = [];
    const frame = parseNodeOutputText(records[0]!);
    expect(frame).not.toBeNull();
    expect(ingress.receive(frame!)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    const remote = ledger.currentRows(remoteChat);
    expect(remote).toEqual([{ ...local[0], viewId: remote[0]!.viewId }]);
    expect(ingress.receive(frame!)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    expect(ledger.currentRows(remoteChat)).toEqual(remote);
    expect(failures).toEqual([]);
    expect(encoder.retired).toBe(false);
  } finally { ledger.close(); await rm(directory, { recursive: true, force: true }); }
});
