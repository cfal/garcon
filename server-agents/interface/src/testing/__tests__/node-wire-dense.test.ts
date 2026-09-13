import { expect, test } from 'bun:test';
import { AssistantMessage, McpToolUseMessage } from '@garcon/common/chat-types';
import type { AgentProducerEvent } from '../../contracts/producer.js';
import {
  decodeWireProducerEvent, encodeWireProducerEvent, MAX_NODE_OUTPUT_BYTES,
  parseNodeOutputText, serializeNodeOutputFrame,
} from '../../node-wire.js';

const at = '2026-09-12T00:00:00.000Z';
const stream = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node',
  logicalSessionId: 'synthetic-session', streamId: 'synthetic-stream' };
const permissionOccurrenceId = '00000000-0000-4000-8000-000000000001';
const decision = { permissionOccurrenceId, async respond() {} };

test.each(['metadata', 'tool', 'permission'] as const)('dense %s survives the complete output codec below the frame allowance', (kind) => {
  const payload = { values: Array.from({ length: 300_000 }, () => 0), objects: Array.from({ length: 100_000 }, () => ({ value: 1 })) };
  let event: AgentProducerEvent;
  switch (kind) {
    case 'metadata':
      event = { type: 'rows', rows: [{ message: new AssistantMessage(at, 'synthetic'), providerMeta: payload }] };
      break;
    case 'tool':
      event = { type: 'rows', rows: [{ message: new McpToolUseMessage(at, 'synthetic-tool', 'synthetic-server', 'synthetic-tool', payload) }] };
      break;
    case 'permission':
      event = { type: 'permission', runId: 'synthetic-run', lifecycle: { kind: 'requested', permissionOccurrenceId,
        requestedTool: new McpToolUseMessage(at, 'synthetic-tool', 'synthetic-server', 'synthetic-tool', payload),
        options: [{ id: 'allow', label: 'Allow', payload }] }, decision };
      break;
  }
  let registered = 0;
  const encoded = encodeWireProducerEvent(event, { createHandle: () => 'synthetic-decision', register() { registered++; } });
  const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: encoded });
  expect(Buffer.byteLength(serialized)).toBeLessThan(MAX_NODE_OUTPUT_BYTES);
  const parsed = parseNodeOutputText(serialized);
  expect(parsed).not.toBeNull();
  const decoded = decodeWireProducerEvent(parsed!.event, () => decision);
  expect(JSON.stringify(decoded)).toBe(JSON.stringify(event));
  expect(registered).toBe(kind === 'permission' ? 1 : 0);
});

test('impossible array lengths exhaust traversal before reading any element', () => {
  let reads = 0;
  const values = new Proxy<number[]>([], { get(target, property, receiver) {
    if (property === 'length') return MAX_NODE_OUTPUT_BYTES + 1;
    if (property === '0') reads++;
    return Reflect.get(target, property, receiver);
  } });
  expect(() => encodeWireProducerEvent({ type: 'rows', rows: [{
    message: new AssistantMessage(at, 'synthetic'), providerMeta: { values },
  }] }, { createHandle() { throw new Error('Unexpected permission'); }, register() {} })).toThrow('snapshot value limit');
  expect(reads).toBe(0);
});
