import { expect, test } from 'bun:test';
import { manifest, session } from '../../../execution-node/worker/__tests__/lifecycle-fixture.js';
import { MAX_NODE_SESSION_MANIFESTS, MAX_NODE_SESSION_READY_BYTES, parseNodeSessionFrameText, serializeNodeSessionFrame,
  type NodeSessionFrame } from '../session-wire.js';

const frames: NodeSessionFrame[] = [
  { type: 'node-controller-hello', version: 1, controllerId: 'synthetic-controller-id', controllerBootId: session.controllerBootId, nodeId: 'synthetic-node' },
  { type: 'node-session-accepted', version: 1, controllerId: 'synthetic-controller-id', nodeId: 'synthetic-node', session, connectionId: 1 },
  { type: 'node-session-ready', version: 1, session, connectionId: 1, manifests: [manifest()] },
  { type: 'node-session-rejected', version: 1, code: 'NODE_INCOMPATIBLE' },
];

test.each(frames)('round-trips the explicit session envelope $type', (frame) => {
  expect(parseNodeSessionFrameText(serializeNodeSessionFrame(frame))).toEqual(frame);
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frame, credential: 'synthetic-unexpected-secret' }))).toBeNull();
});

test('unknown hello versions remain identifiable before authority while accepted and ready require the exact version', () => {
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[0], version: 2 }))).toMatchObject({ version: 2 });
  for (const frame of frames.slice(1)) expect(parseNodeSessionFrameText(JSON.stringify({ ...frame, version: 2 }))).toBeNull();
});

test('rejects malformed, oversized and ambiguous session advertisements', () => {
  expect(parseNodeSessionFrameText(' ' .repeat(MAX_NODE_SESSION_READY_BYTES + 1))).toBeNull();
  for (const connectionId of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[1], connectionId }))).toBeNull();
  }
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[1], session: { ...session, credential: 'synthetic-secret' } }))).toBeNull();
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[2], manifests: [manifest(), manifest()] }))).toBeNull();
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[2], manifests: [manifest(), { ...manifest(), nodeId: 'synthetic-other', instanceId: 'synthetic-other' }] }))).toBeNull();
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[2], manifests: Array.from({ length: MAX_NODE_SESSION_MANIFESTS + 1 }, (_, i) => ({ ...manifest(), instanceId: `synthetic-${i}` })) }))).toBeNull();
  expect(parseNodeSessionFrameText(JSON.stringify({ ...frames[3], code: 'SYNTHETIC_UNKNOWN' }))).toBeNull();
});

test('deserialization owns metadata independently from caller mutation', () => {
  const input = { ...manifest(), descriptor: { ...manifest().descriptor } };
  const parsed = parseNodeSessionFrameText(JSON.stringify({ ...frames[2], manifests: [input] }));
  input.descriptor.label = 'Synthetic replacement';
  expect(parsed).toMatchObject({ manifests: [{ descriptor: { label: 'Synthetic' } }] });
});
