import { describe, expect, test } from 'bun:test';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import { parseNodeOutputText, producerStreamKey } from '@garcon/server-agent-interface';
import { NodeOutputStream } from '../output-stream.js';
import { NodeReplayCache } from '../replay-cache.js';
import { OrderedPublicationIngress } from '../../execution-nodes/publication-ingress.js';

const identity = {
  controllerBootId: 'controller-a', nodeBootId: 'node-a', logicalSessionId: 'logical-a', streamId: 'stream-a',
};
const event = (content) => ({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', content) }] });
const occurrence = '00000000-0000-4000-8000-000000000001';
function permissionEvent(decision = { permissionOccurrenceId: occurrence, async respond() {} }) {
  return {
    type: 'permission', runId: 'run-a', decision,
    lifecycle: {
      kind: 'requested', permissionOccurrenceId: decision.permissionOccurrenceId,
      requestedTool: new BashToolUseMessage('2026-09-09T00:00:00.000Z', 'tool-a', 'pwd'),
      options: [{ id: 'allow', label: 'Allow' }],
    },
  };
}

function fixture({ onOutputFailure, onTransportFailure } = {}) {
  const cache = new NodeReplayCache();
  const failures = [];
  const disconnects = [];
  const permissions = new Map();
  const generated = [];
  const registrations = [];
  const registeredHandles = new Set();
  const retirements = [];
  /** @satisfies {import('../output-stream.js').NodeOutputPermissionHandles} */
  const permissionHandles = {
    createHandle() {
      const handle = `decision-${generated.length + 1}`;
      generated.push(handle);
      return handle;
    },
    register(stream, handle, decision, runId) {
      if (registeredHandles.has(handle)) throw new Error('Permission handle was already registered');
      const entry = { stream, handle, decision, runId };
      registeredHandles.add(handle);
      registrations.push(entry);
      permissions.set(handle, entry);
    },
    retire(stream) {
      retirements.push(stream);
      for (const [handle, entry] of permissions) {
        if (producerStreamKey(entry.stream) === producerStreamKey(stream)) permissions.delete(handle);
      }
    },
  };
  const createOutput = (stream = identity) => new NodeOutputStream({
    identity: stream, cache, permissionHandles,
    onOutputFailure(error) { failures.push(error); onOutputFailure?.(error); },
    onTransportFailure(error) { disconnects.push(error); onTransportFailure?.(error); },
  });
  return {
    cache, output: createOutput(), createOutput, failures, disconnects,
    permissions, generated, registrations, retirements, permissionHandles,
  };
}

describe('remote provider emission', () => {
  test('emits a requested permission with one exact registered capability and a parseable frame', async () => {
    const { output, cache, generated, permissions, registrations, failures, disconnects } = fixture();
    const responses = [];
    const decision = { permissionOccurrenceId: occurrence, async respond(payload) { responses.push([this, payload]); } };
    const sent = [];
    output.resumeLive(output.beginRecovery(), 0, (serialized) => sent.push(serialized));
    output.emit(permissionEvent(decision));
    expect(sent).toHaveLength(1);
    expect(generated).toEqual(['decision-1']);
    expect(registrations).toHaveLength(1);
    expect(permissions.size).toBe(1);
    const frame = parseNodeOutputText(sent[0]);
    expect(frame).toMatchObject({ type: 'node-output', stream: identity, sequence: 1,
      event: { type: 'permission', runId: 'run-a', decisionHandle: 'decision-1',
        lifecycle: { permissionOccurrenceId: occurrence, requestedTool: { type: 'bash-tool-use', command: 'pwd' } } },
    });
    const registered = permissions.get(frame.event.decisionHandle);
    expect(registered).toMatchObject({ stream: identity, runId: 'run-a' });
    expect(Object.isFrozen(registered.decision)).toBe(true);
    await registered.decision.respond({ optionId: 'allow' });
    expect(responses).toEqual([[decision, { optionId: 'allow' }]]);
    expect(cache.read(identity, 1, 1).serialized).toBe(sent[0]);
    expect(failures).toEqual([]);
    expect(disconnects).toEqual([]);
  });

  test('an invalid handle registers no authority and retires the failed stream once', () => {
    const { output, permissionHandles, permissions, registrations, retirements, failures } = fixture();
    permissionHandles.createHandle = () => '';
    expect(() => output.emit(permissionEvent())).toThrow('Invalid permission decision handle');
    expect(registrations).toEqual([]);
    expect(permissions.size).toBe(0);
    expect(output.producedSequence).toBe(0);
    expect(failures).toHaveLength(1);
    output.retire();
    expect(retirements).toEqual([identity]);
  });

  test('a failed registration retires prior authority without retaining the rejected capability', () => {
    const { output, permissionHandles, permissions, registrations, retirements, failures, cache } = fixture();
    output.emit(permissionEvent());
    const failure = new Error('Synthetic registration failure');
    permissionHandles.register = () => { throw failure; };
    expect(() => output.emit(permissionEvent())).toThrow(failure);
    expect(permissions.size).toBe(0);
    expect(registrations).toHaveLength(1);
    expect(output.producedSequence).toBe(1);
    expect(cache.streamCount).toBe(0);
    expect(failures).toEqual([failure]);
    output.retire();
    expect(retirements).toEqual([identity]);
  });

  test('cache teardown failure still revokes permission authority and closes delivery', () => {
    const { output, cache, permissions, retirements } = fixture();
    output.emit(permissionEvent());
    const attempt = output.beginRecovery();
    const failure = new Error('Synthetic cache teardown failure');
    cache.retire = () => { throw failure; };
    expect(() => output.retire()).toThrow(failure);
    expect(permissions.size).toBe(0);
    expect(retirements).toEqual([identity]);
    expect(output.resumeLive(attempt, 1, () => {})).toBe(false);
    expect(() => output.emit(permissionEvent())).toThrow('retired');
    expect(() => output.retire()).not.toThrow();
    expect(retirements).toEqual([identity]);
  });

  test('reports output and teardown failures together while throwing the original output error', () => {
    const { output, cache, permissions, retirements, failures, disconnects } = fixture();
    output.emit(permissionEvent());
    const failure = new Error('Synthetic cache append failure');
    const cleanupFailure = new Error('Synthetic cache teardown failure');
    cache.append = () => { throw failure; };
    cache.retire = () => { throw cleanupFailure; };
    expect(() => output.emit(permissionEvent())).toThrow(failure);
    expect(permissions.size).toBe(0);
    expect(retirements).toEqual([identity]);
    expect(output.producedSequence).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(AggregateError);
    expect(failures[0].cause).toBe(failure);
    expect(failures[0].errors).toEqual([failure, cleanupFailure]);
    expect(disconnects).toEqual([]);
  });

  test('a throwing output-failure observer cannot replace the original error or prevent revocation', () => {
    const { output, cache, permissions, failures, retirements } = fixture({
      onOutputFailure() { throw new Error('Synthetic observer failure'); },
    });
    output.emit(permissionEvent());
    const failure = new Error('Synthetic cache append failure');
    cache.append = () => { throw failure; };
    expect(() => output.emit(permissionEvent())).toThrow(failure);
    expect(failures).toEqual([failure]);
    expect(permissions.size).toBe(0);
    expect(cache.streamCount).toBe(0);
    expect(retirements).toEqual([identity]);
    expect(() => output.emit(event('late'))).toThrow('retired');
  });

  test('a throwing transport-failure observer cannot reject locally retained output', () => {
    const { output, cache, permissions, registrations, failures, disconnects } = fixture({
      onTransportFailure() { throw new Error('Synthetic observer failure'); },
    });
    const failure = new Error('Synthetic disconnect');
    const attempt = output.beginRecovery();
    output.resumeLive(attempt, 0, () => { throw failure; });
    expect(() => output.emit(permissionEvent())).not.toThrow();
    expect(output.producedSequence).toBe(1);
    expect(disconnects).toEqual([failure]);
    expect(failures).toEqual([]);
    expect(output.suspend(attempt)).toBe(false);
    const frame = parseNodeOutputText(cache.read(identity, 1, 1).serialized);
    expect(permissions.get(frame.event.decisionHandle)).toBe(registrations[0]);
    const sent = [];
    expect(output.resumeLive(output.beginRecovery(), 1, (serialized) => sent.push(serialized))).toBe(true);
    output.emit(event('reconnected'));
    expect(sent.map((serialized) => parseNodeOutputText(serialized).sequence)).toEqual([2]);
    expect(registrations).toHaveLength(1);
  });

  test.each([false, true])('a registrar refuses handle reuse across streams after retirement: %s', async (retired) => {
    const { output, createOutput, permissionHandles, permissions, registrations } = fixture();
    const responses = [];
    output.emit(permissionEvent({ permissionOccurrenceId: occurrence, async respond(payload) { responses.push(payload); } }));
    const original = registrations[0];
    if (retired) output.retire();
    const peer = createOutput({ ...identity, streamId: 'peer-stream' });
    permissionHandles.createHandle = () => original.handle;
    expect(() => peer.emit(permissionEvent())).toThrow('already registered');
    expect(registrations).toEqual([original]);
    expect(permissions.size).toBe(retired ? 0 : 1);
    if (!retired) {
      expect(permissions.get(original.handle)).toBe(original);
      await permissions.get(original.handle).decision.respond({ optionId: 'allow' });
      expect(responses).toEqual([{ optionId: 'allow' }]);
    }
  });

  test('cache failure releases newly registered authority and prior handles only for the affected stream', () => {
    const { output, createOutput, cache, registrations, permissions, retirements, failures, disconnects } = fixture();
    const peerIdentity = { ...identity, streamId: 'peer-stream' };
    const peer = createOutput(peerIdentity);
    output.emit(permissionEvent());
    peer.emit(permissionEvent());
    const sent = [];
    output.resumeLive(output.beginRecovery(), 1, (serialized) => sent.push(serialized));
    cache.retire(identity);
    expect(() => output.emit(permissionEvent())).toThrow('retired or unknown');
    expect(registrations).toHaveLength(3);
    expect([...permissions.values()]).toEqual([registrations[1]]);
    expect(output.producedSequence).toBe(1);
    expect(sent).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(disconnects).toEqual([]);
    output.retire();
    expect(retirements).toEqual([identity]);
    peer.emit(event('peer remains usable'));
    expect(peer.producedSequence).toBe(2);
    peer.retire();
    expect(permissions.size).toBe(0);
    expect(retirements).toEqual([identity, peerIdentity]);
  });

  test('retirement during event capture cannot register authority after cleanup', () => {
    const { output, permissions, registrations, retirements, failures } = fixture();
    const permission = permissionEvent();
    expect(() => output.emit({
      ...permission,
      get lifecycle() { output.retire(); return permission.lifecycle; },
    })).toThrow('retired');
    expect(registrations).toEqual([]);
    expect(permissions.size).toBe(0);
    expect(retirements).toEqual([identity]);
    expect(failures).toHaveLength(1);
    expect(output.producedSequence).toBe(0);
  });

  test('socket failure and replay preserve the original handles without registering them again', () => {
    const { output, cache, permissions, registrations, retirements, failures, disconnects } = fixture();
    const attempt = output.beginRecovery();
    output.resumeLive(attempt, 0, () => { throw new Error('Synthetic disconnect'); });
    output.emit(permissionEvent());
    const registered = registrations[0];
    expect(output.suspend(attempt)).toBe(false);
    const recovery = output.beginRecovery();
    const watermark = cache.capture(identity, 0);
    const frame = parseNodeOutputText(cache.read(identity, 1, watermark.throughSequence).serialized);
    expect(permissions.get(frame.event.decisionHandle)).toBe(registered);
    const sent = [];
    expect(output.resumeLive(recovery, watermark.throughSequence, (serialized) => sent.push(serialized))).toBe(true);
    output.emit(event('reconnected'));
    expect(sent).toHaveLength(1);
    expect(registrations).toEqual([registered]);
    expect(retirements).toEqual([]);
    expect(disconnects).toHaveLength(1);
    expect(failures).toEqual([]);
    output.retire();
    output.retire();
    expect(permissions.size).toBe(0);
    expect(retirements).toEqual([identity]);
  });

  test('lost ACK and newer live arrivals recover in order through the same captured publisher', () => {
    const { cache, output, failures, disconnects } = fixture();
    const published = [];
    const ingress = new OrderedPublicationIngress({
      stream: identity, sink: { publish: (item) => published.push(item) }, permission() { throw new Error('Unexpected permission'); },
    });
    const receive = (serialized, acknowledge = true) => {
      const received = ingress.receive(parseNodeOutputText(serialized));
      expect(received.kind).toBe('ack');
      if (acknowledge) cache.acknowledge(identity, received.ack.throughSequence);
    };
    const firstAttempt = output.beginRecovery();
    output.resumeLive(firstAttempt, 0, (serialized) => receive(serialized, false));
    output.emit(event('first'));
    output.suspend(firstAttempt);
    output.emit(event('second'));
    const recovery = output.beginRecovery();
    const watermark = cache.capture(identity, 0);
    expect(watermark).toMatchObject({ type: 'node-replay-ready', throughSequence: 2 });
    output.emit(event('third'));
    for (let sequence = 1; sequence <= watermark.throughSequence; sequence += 1) {
      receive(cache.read(identity, sequence, watermark.throughSequence).serialized);
    }
    expect(output.resumeLive(recovery, watermark.throughSequence, receive)).toBe(false);
    receive(cache.read(identity, 3, 3).serialized);
    expect(output.resumeLive(recovery, 3, receive)).toBe(true);
    output.emit(event('fourth'));
    expect(failures).toEqual([]);
    expect(disconnects).toEqual([]);
    expect(published.map((item) => item.rows[0].message.content)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(cache.retainedBytes).toBe(0);
  });

  test('snapshots output once before live delivery and retained replay', () => {
    const { cache, output } = fixture();
    const sent = [];
    output.resumeLive(output.beginRecovery(), 0, (serialized) => sent.push(serialized));
    const original = event('original');
    output.emit(original);
    original.rows[0].message.content = 'mutated';
    expect(cache.read(identity, 1, 1).serialized).toBe(sent[0]);
    expect(parseNodeOutputText(sent[0]).event.rows[0].message.content).toBe('original');
  });

  test('socket failure suspends sending without retrying the command or losing retained output', () => {
    const { cache, output, failures, disconnects } = fixture();
    let sends = 0;
    output.resumeLive(output.beginRecovery(), 0, () => { sends += 1; throw new Error('Synthetic disconnect'); });
    expect(() => output.emit(event('first'))).not.toThrow();
    output.emit(event('second'));
    expect(sends).toBe(1);
    expect(disconnects).toHaveLength(1);
    expect(failures).toEqual([]);
    expect(cache.capture(identity, 0)).toMatchObject({ type: 'node-replay-ready', throughSequence: 2 });
  });

  test('beginning recovery unbinds live delivery while preserving the newer output', () => {
    const { cache, output } = fixture();
    const sent = [];
    output.resumeLive(output.beginRecovery(), 0, (serialized) => sent.push(serialized));
    output.emit(event('live'));
    const recovery = output.beginRecovery();
    output.emit(event('held for recovery'));
    expect(sent).toHaveLength(1);
    expect(output.producedSequence).toBe(2);
    const retained = cache.read(identity, 2, 2);
    expect(retained.kind).toBe('record');
    expect(parseNodeOutputText(retained.serialized).event.rows[0].message.content).toBe('held for recovery');
    expect(output.resumeLive(recovery, 2, (serialized) => sent.push(serialized))).toBe(true);
    output.emit(event('live again'));
    expect(sent.map((serialized) => parseNodeOutputText(serialized).sequence)).toEqual([1, 3]);
  });

  test('invalid output retires only the source and reports failure rather than emitting a success suffix', () => {
    const { cache, output, failures, disconnects } = fixture();
    const attempt = output.beginRecovery();
    output.emit(event('first'));
    expect(() => output.emit({ type: 'invalid' })).toThrow('Invalid normalized');
    expect(failures).toHaveLength(1);
    expect(disconnects).toEqual([]);
    expect(cache.streamCount).toBe(0);
    expect(output.resumeLive(attempt, 1, () => {})).toBe(false);
    expect(() => output.emit(event('late'))).toThrow('retired');
    expect(failures).toHaveLength(1);
  });

  test('stale recovery and socket close cannot replace or suspend a newer live sender', () => {
    const { output } = fixture();
    const oldAttempt = output.beginRecovery();
    const current = output.beginRecovery();
    const sent = [];
    const staleSender = () => { throw new Error('Stale sender must not run'); };
    expect(output.resumeLive(current, 0, (value) => sent.push(value))).toBe(true);
    expect(output.resumeLive(oldAttempt, 0, staleSender)).toBe(false);
    expect(output.suspend(oldAttempt)).toBe(false);
    expect(output.resumeLive({ ...current }, 0, staleSender)).toBe(false);
    output.emit(event('current'));
    expect(sent).toHaveLength(1);
    expect(output.resumeLive(current, 0, staleSender)).toBe(false);
    output.emit(event('held for recovery'));
    expect(sent).toHaveLength(1);
  });

  test('a replaced sender throwing reentrantly cannot invalidate its replacement', () => {
    const { output, disconnects } = fixture();
    const sent = [];
    output.resumeLive(output.beginRecovery(), 0, () => {
      output.resumeLive(output.beginRecovery(), 1, (value) => sent.push(value));
      throw new Error('Old socket failed after replacement');
    });
    output.emit(event('first'));
    output.emit(event('second'));
    expect(sent).toHaveLength(1);
    expect(disconnects).toEqual([]);
  });

  test('clearing the cache invalidates emission without a partial live send or accepted sequence', () => {
    const { cache, output, failures } = fixture();
    const sent = [];
    output.resumeLive(output.beginRecovery(), 0, (value) => sent.push(value));
    cache.clear();
    expect(() => output.emit(event('lost authority'))).toThrow('retired or unknown');
    expect(output.producedSequence).toBe(0);
    expect(failures).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  test('reconnect racing retirement rejects every recovery entry without throwing', () => {
    const { output } = fixture();
    const attempt = output.beginRecovery();
    output.retire();
    expect(output.beginRecovery()).toBeNull();
    expect(output.suspend(attempt)).toBe(false);
    expect(output.resumeLive(attempt, 0, () => {})).toBe(false);
  });

  test('a missing recovery attempt cannot bind a sender before recovery starts', () => {
    const { output } = fixture();
    const sent = [];
    expect(output.resumeLive(null, 0, (value) => sent.push(value))).toBe(false);
    expect(output.suspend(null)).toBe(false);
    output.emit(event('retained only'));
    expect(sent).toEqual([]);
  });

  test('optional terminal fields set to undefined do not retire the publisher or discard late output', () => {
    const { output, cache, failures } = fixture();
    output.emit({ type: 'run-ended', runId: 'run-a', outcome: 'finished', error: undefined });
    output.emit(event('late content'));
    expect(output.producedSequence).toBe(2);
    expect(cache.capture(identity, 0)).toMatchObject({ type: 'node-replay-ready', throughSequence: 2 });
    expect(failures).toEqual([]);
  });
});

test.each(['event capture', 'registration', 'admission'])('reentrant %s fences the stream without duplicate sequences', (phase) => {
  const { output, cache, permissionHandles, failures, permissions } = fixture();
  const reenter = () => { try { output.emit(event('nested')); } catch {} };
  let value = event('outer');
  if (phase === 'event capture') value = { type: 'rows', get rows() { reenter(); return []; } };
  if (phase === 'registration') { permissionHandles.register = reenter; value = permissionEvent(); }
  if (phase === 'admission') cache.append = reenter;
  expect(() => output.emit(value)).toThrow('retired');
  expect(failures).toHaveLength(1);
  expect(output.producedSequence).toBe(0);
  expect(cache.streamCount).toBe(0);
  expect(permissions.size).toBe(0);
});

test('inline delivery may emit again after the preceding record advances its sequence', () => {
  const { output, failures } = fixture();
  const sequences = [];
  output.resumeLive(output.beginRecovery(), 0, (text) => {
    const frame = parseNodeOutputText(text);
    sequences.push(frame.sequence);
    if (frame.sequence === 1) output.emit(event('second'));
  });
  output.emit(event('first'));
  expect(sequences).toEqual([1, 2]);
  expect(output.producedSequence).toBe(2);
  expect(failures).toEqual([]);
});

test('a post-admission callback failure preserves its sequence and retires the encoder before notification', async () => {
  const { NodeOutputEncoder } = await import('../output-encoder.js');
  const f = fixture(); const failures = [];
  const failure = new Error('Synthetic delivery callback');
  let closed = false;
  const encoder = new NodeOutputEncoder({ identity, permissionHandles: f.permissionHandles,
    accept() {}, retire() { closed = true; }, accepted() { throw failure; },
    onOutputFailure(error) { expect(closed).toBe(true); failures.push(error); },
  });
  expect(() => encoder.emit(permissionEvent())).toThrow(failure);
  expect(encoder.producedSequence).toBe(1);
  expect(f.permissions.size).toBe(0); expect(failures).toEqual([failure]);
  expect(() => encoder.emit(event('late'))).toThrow('retired');
  f.output.retire();
});
