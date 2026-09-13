import { expect, test } from 'bun:test';
import { nodeWorkerApplicationSession, parseNodeWorkerApplicationText } from '../application-protocol.js';
import { chunkNodeWorkerOutput } from '../output-protocol.js';
import { session } from './lifecycle-fixture.js';
import { parseNodeWorkerOutputRetirementText, serializeNodeWorkerOutputRetirement } from '../output-retirement.js';

test('the worker application dispatcher preserves each strict nested frame and its logical namespace', () => {
  const stream = { ...session, streamId: 'synthetic-stream' };
  const envelope = { version: 1, session, connectionId: 1 };
  const output = chunkNodeWorkerOutput('synthetic-instance', JSON.stringify({ type: 'node-output', stream, sequence: 1,
    event: { type: 'notice', runId: 'synthetic-run', content: 'synthetic notice' } }))[0]!;
  const frames = [
    { ...envelope, type: 'node-worker-execution', instanceId: 'synthetic-instance', payload: '{}' },
    { ...envelope, type: 'node-worker-bulk', instanceId: 'synthetic-instance', payload: JSON.stringify({ type: 'node-bulk-result', command: 'node-bulk-complete',
      version: 1, session, requestId: 1, result: 'completed' }) },
    JSON.parse(output),
    { ...envelope, type: 'node-worker-output-delivery', generation: 1, payload: output },
    { ...envelope, type: 'node-worker-output-suspended', generation: 1 },
    { type: 'node-worker-output-retired', reason: 'output-retired', version: 1, instanceId: 'synthetic-instance', stream },
    { type: 'node-worker-output-ack', version: 1, connectionId: 1, generation: 1,
      ack: { type: 'node-output-ack', stream, throughSequence: 1 } },
    { ...envelope, type: 'node-worker-service-request', timeoutMs: 10_000, requestId: 1, command: { method: 'begin-output-recovery' } },
    { ...envelope, type: 'node-worker-service-result', requestId: 1, result: { kind: 'unknown' } },
    { ...envelope, type: 'node-worker-service-cancel', requestId: 1 },
  ];
  for (const frame of frames) {
    const parsed = parseNodeWorkerApplicationText(JSON.stringify(frame));
    expect(parsed).toEqual(frame); expect(nodeWorkerApplicationSession(parsed!)).toMatchObject(session);
    expect(parseNodeWorkerApplicationText(JSON.stringify({ ...frame, extra: true }))).toBeNull();
  }
  for (const text of ['null', '{}', '{"type":"unknown"}', '{"type":"node-worker-bulk","payload":"{}"}']) {
    expect(parseNodeWorkerApplicationText(text)).toBeNull();
  }
});

test('retirement reasons round trip explicitly and cannot carry untyped diagnostics', () => {
  const frame = { type: 'node-worker-output-retired', version: 1, instanceId: 'synthetic-instance',
    stream: { ...session, streamId: 'synthetic-stream' } } as const;
  for (const reason of ['output-retired', 'replay-gap'] as const) {
    const retirement = { ...frame, reason };
    const text = serializeNodeWorkerOutputRetirement(retirement);
    expect(parseNodeWorkerOutputRetirementText(text)).toEqual(retirement);
    expect(parseNodeWorkerApplicationText(text)).toEqual(retirement);
  }
  for (const reason of [undefined, null, 'native-settled', { message: 'synthetic private diagnostic' }]) {
    expect(parseNodeWorkerOutputRetirementText(JSON.stringify({ ...frame, reason }))).toBeNull();
  }
});
