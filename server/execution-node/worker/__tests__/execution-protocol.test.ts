import { expect, test } from 'bun:test';
import { MAX_NODE_EXECUTION_FRAME_BYTES } from '../../../execution-nodes/transport/execution-wire.js';
import { parseNodeWorkerExecutionText, serializeNodeWorkerExecution } from '../execution-protocol.js';
import { session } from './lifecycle-fixture.js';

test('worker execution envelopes preserve private payload bytes and the exact physical namespace', () => {
  const frame = { type: 'node-worker-execution', version: 1, session, connectionId: 2, instanceId: 'synthetic-instance', payload: '{"synthetic":"界\\n"}' } as const;
  expect(parseNodeWorkerExecutionText(serializeNodeWorkerExecution(frame))).toEqual(frame);
  for (const invalid of [{ ...frame, secret: 'synthetic' }, { ...frame, version: 2 }, { ...frame, connectionId: 0 },
    { ...frame, connectionId: 1.5 }, { ...frame, instanceId: '' }, { ...frame, instanceId: null },
    { ...frame, session: { ...session, nodeBootId: '' } },
    { ...frame, payload: '' }, { ...frame, payload: [] }, { ...frame, payload: 'x'.repeat(MAX_NODE_EXECUTION_FRAME_BYTES + 1) }]) {
    expect(parseNodeWorkerExecutionText(JSON.stringify(invalid))).toBeNull();
  }
});
