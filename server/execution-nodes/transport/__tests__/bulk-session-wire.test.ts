import { expect, test } from 'bun:test';
import { MAX_NODE_BULK_SESSION_FRAME_BYTES, parseNodeBulkSessionFrameText, serializeNodeBulkSessionFrame, type NodeBulkSessionFrame } from '../bulk-session-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const kinds: NodeBulkSessionFrame['type'][] = ['node-bulk-session-hello', 'node-bulk-session-ready'];

test.each(kinds)('round-trips the exact bulk-session envelope %s', (type) => {
  const frame: NodeBulkSessionFrame = { type, version: 1, session, connectionId: 2 };
  expect(parseNodeBulkSessionFrameText(serializeNodeBulkSessionFrame(frame))).toEqual(frame);
  for (const connectionId of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    expect(parseNodeBulkSessionFrameText(JSON.stringify({ ...frame, connectionId }))).toBeNull();
  }
  for (const altered of [{ ...frame, version: 2 }, { ...frame, credential: 'synthetic-secret' },
    { ...frame, session: { ...session, extra: true } }, { ...frame, type: 'node-session-ready' }]) {
    expect(parseNodeBulkSessionFrameText(JSON.stringify(altered))).toBeNull();
  }
});

test('rejects malformed and oversized bulk-session frames', () => {
  for (const text of ['null', '{', '{}', ' '.repeat(MAX_NODE_BULK_SESSION_FRAME_BYTES + 1)]) expect(parseNodeBulkSessionFrameText(text)).toBeNull();
});
