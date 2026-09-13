import { expect, mock, test } from 'bun:test';
import { NodeWorkerAuthority } from '../authority.js';
import { NodeWorkerContainmentRelay } from '../containment-relay.js';
import { parseNodeWorkerChildText, serializeNodeWorkerChild, type NodeWorkerContainmentRequest } from '../protocol.js';
import { NodeWorkerWriter } from '../writer.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { session, tick } from './lifecycle-fixture.js';

const request: NodeWorkerContainmentRequest = {
  type: 'node-worker-containment-request', version: 1, session,
  instanceId: 'synthetic-instance', operationId: 'synthetic-operation', reason: 'native-settlement-unconfirmed',
};

test('containment reports use a closed, exact logical-session contract', () => {
  expect(parseNodeWorkerChildText(serializeNodeWorkerChild(request))).toEqual(request);
  for (const patch of [
    { version: 2 }, { session: { ...session, nodeBootId: '' } }, { instanceId: '' }, { operationId: 'bad/identity' },
    { reason: 'settled' }, { prompt: 'synthetic-private-content' }, { connectionId: 2 },
  ]) expect(parseNodeWorkerChildText(JSON.stringify({ ...request, ...patch }))).toBeNull();
  for (const field of Object.keys(request)) {
    const missing = { ...request };
    Reflect.deleteProperty(missing, field);
    expect(parseNodeWorkerChildText(JSON.stringify(missing))).toBeNull();
  }
});

test('the lifecycle relay fences admission immediately and retires authority after its bounded write', async () => {
  const lifetime = new AbortController();
  const authority = new NodeWorkerAuthority({ session, signal: lifetime.signal, poll: () => 1 });
  const connection = authority.attach(1);
  authority.openAdmissions(1);
  const drained = Promise.withResolvers<void>();
  const sent: NodeWorkerContainmentRequest[] = [];
  const writer = new NodeWorkerWriter({ write: mock(async (bytes) => {
    const message = parseNodeWorkerChildText(Buffer.from(bytes.subarray(4)).toString());
    if (message?.type !== 'node-worker-containment-request') throw new Error('Synthetic containment frame missing');
    sent.push(message);
    await drained.promise;
  }), close() {} }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed() {} });
  const relay = new NodeWorkerContainmentRelay(authority, writer);
  try {
    relay.request(request);
    relay.request(request);
    expect(sent).toEqual([request]);
    expect(() => authority.assertAdmission(connection)).toThrow('suspended');
    expect(() => authority.assertConnection(connection)).not.toThrow();
    expect(authority.signal.aborted).toBe(false);
    const replacement = authority.attach(2);
    expect(() => authority.openAdmissions(2)).toThrow('containment');
    expect(() => authority.assertConnection(replacement)).not.toThrow();
    drained.resolve();
    await tick();
    expect(authority.signal.aborted).toBe(true);
    expect(sent).toHaveLength(1);
  } finally { drained.resolve(); lifetime.abort(); writer.close(); }
});

test.each(['admission', 'write'] as const)('a failed %s still retires authority without claiming settlement', async (failure) => {
  const authority = new NodeWorkerAuthority({ session, signal: new AbortController().signal, poll: () => 1 });
  authority.attach(1);
  const writer = { submit: mock<NodeWorkerWriter['submit']>(() => {
    if (failure === 'admission') throw new Error('Synthetic lifecycle admission failure');
    return { submitted: true, drained: Promise.reject(new Error('Synthetic native write failure')) };
  }) } satisfies Pick<NodeWorkerWriter, 'submit'>;
  const relay = new NodeWorkerContainmentRelay(authority, writer);
  relay.request(request);
  await tick();
  expect(authority.signal.aborted).toBe(true);
  expect(writer.submit).toHaveBeenCalledTimes(1);
  expect(writer.submit.mock.calls[0]![1]).toBe('control');
  expect(writer.submit.mock.calls[0]![3]).toBe('lifecycle');
});
