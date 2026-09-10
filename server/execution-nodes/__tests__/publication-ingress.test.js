import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import { encodeWireProducerEvent, parseNodeOutputText, serializeNodeOutputFrame } from '@garcon/server-agent-interface';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { OrderedPublicationIngress } from '../publication-ingress.js';

const stream = Object.freeze({
  controllerBootId: 'controller-boot-a', nodeBootId: 'node-boot-a', logicalSessionId: 'session-a', streamId: 'stream-a',
});
const at = '2026-09-09T00:00:00.000Z';
const occurrence = '00000000-0000-4000-8000-000000000001';
const unusedPermission = () => { throw new Error('Unexpected permission resolution'); };
/** @satisfies {import('@garcon/server-agent-interface').NodePermissionHandleRegistrar} */
const permissionHandles = { createHandle: () => 'decision-a', register() {} };
function frame(sequence, event, identity = stream) {
  return parseNodeOutputText(serializeNodeOutputFrame({
    type: 'node-output', stream: identity, sequence,
    event: encodeWireProducerEvent(event, permissionHandles),
  }));
}

describe('ordered controller publication ingress', () => {
  test('lost ACK replays multi-row output without duplicate V5 rows or extracted commands', async () => {
    const directory = await mkdtemp(join(homedir(), 'garcon-node-ingress-'));
    let requests = 0;
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory), {
      chatIdRequests: { request() { requests += 1; expect(ledger.currentRows('chat-a')).toHaveLength(3); } },
    });
    try {
      ledger.initializeChat('chat-a');
      const lease = ledger.openProducer('chat-a', 'test');
      const ingress = new OrderedPublicationIngress({ stream, sink: lease.sink, permission: unusedPermission });
      const output = frame(1, { type: 'rows', rows: [
        { message: new AssistantMessage(at, 'synthetic first') },
        { message: new AssistantMessage(at, '<garcon-get-chat-id />\nsynthetic second') },
      ] });
      expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
      const committed = ledger.currentRows('chat-a');
      expect(committed.map((row) => row.ordinal)).toEqual([1, 2, 3]);
      expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
      expect(ledger.currentRows('chat-a')).toEqual(committed);
      expect(requests).toBe(1);

      const advisory = frame(2, { type: 'notice', runId: 'stale-run', content: 'synthetic stale advisory' });
      expect(ingress.receive(advisory)).toMatchObject({ kind: 'ack', ack: { throughSequence: 2 } });
      expect(ledger.currentRows('chat-a')).toEqual(committed);

      lease.close();
      const replacement = ledger.openProducer('chat-a', 'test');
      expect(() => ingress.receive(frame(3, { type: 'rows', rows: [] }))).toThrow('closed');
      expect(ingress.receive(output)).toEqual({ kind: 'retired' });
      replacement.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'replacement') }] });
      expect(ledger.currentRows('chat-a')).toHaveLength(4);
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('requires a contiguous sequence before publication, independent of ledger ordinals', () => {
    const published = [];
    const ingress = new OrderedPublicationIngress({ stream, sink: { publish: (event) => published.push(event) }, permission: unusedPermission });
    const empty = { type: 'rows', rows: [] };
    expect(ingress.receive(frame(2, empty))).toEqual({ kind: 'replay-needed', afterSequence: 0 });
    expect(published).toEqual([]);
    expect(ingress.receive(frame(1, empty)).kind).toBe('ack');
    expect(ingress.receive(frame(2, empty)).kind).toBe('ack');
    expect(ingress.receive(frame(1, empty))).toMatchObject({ kind: 'ack', ack: { throughSequence: 2 } });
    expect(published).toHaveLength(2);
  });

  test.each([1, 2])('rejects reentrant sequence %s until the current publication completes', (nestedSequence) => {
    const published = [];
    const output = frame(1, { type: 'rows', rows: [] });
    let attempted = false;
    let nestedError;
    const ingress = new OrderedPublicationIngress({
      stream, permission: unusedPermission,
      sink: { publish(event) {
        published.push(event);
        if (attempted) return;
        attempted = true;
        expect(ingress.acceptedSequence).toBe(0);
        try { ingress.receive({ ...output, sequence: nestedSequence }); } catch (error) { nestedError = error; }
      } },
    });
    expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    expect(nestedError?.message).toBe('Producer publication is already in progress');
    expect(published).toHaveLength(1);
    expect(ingress.receive(frame(2, { type: 'rows', rows: [] })).kind).toBe('ack');
    expect(published).toHaveLength(2);
  });

  test('guards permission reconstruction against reentrant receipt before publication', () => {
    const published = [];
    let reconstructions = 0;
    let nestedError;
    const decision = { permissionOccurrenceId: occurrence, async respond() {} };
    const output = frame(1, {
      type: 'permission', runId: 'run-a', decision,
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [] },
    });
    const ingress = new OrderedPublicationIngress({
      stream, sink: { publish: (event) => published.push(event) },
      permission() {
        reconstructions += 1;
        if (reconstructions === 1) {
          try { ingress.receive(output); } catch (error) { nestedError = error; }
        }
        return decision;
      },
    });
    expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    expect(nestedError?.message).toBe('Producer publication is already in progress');
    expect(reconstructions).toBe(1);
    expect(published).toHaveLength(1);
  });

  test('retirement during permission reconstruction prevents publication', () => {
    const published = [];
    const decision = { permissionOccurrenceId: occurrence, async respond() {} };
    const ingress = new OrderedPublicationIngress({
      stream, sink: { publish: (event) => published.push(event) },
      permission() { ingress.retire(); return decision; },
    });
    const output = frame(1, {
      type: 'permission', runId: 'run-a', decision,
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [] },
    });
    expect(ingress.receive(output)).toEqual({ kind: 'retired' });
    expect(ingress.acceptedSequence).toBe(0);
    expect(published).toEqual([]);
  });

  test('retirement during successful publication still acknowledges the committed frame', () => {
    const published = [];
    const ingress = new OrderedPublicationIngress({
      stream, permission: unusedPermission,
      sink: { publish(event) { published.push(event); ingress.retire(); } },
    });
    const output = frame(1, { type: 'rows', rows: [] });
    expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    expect(ingress.acceptedSequence).toBe(1);
    expect(ingress.receive(output)).toEqual({ kind: 'retired' });
    expect(published).toHaveLength(1);
  });

  test('rejects out-of-range sequence numbers without publishing or retiring the captured stream', () => {
    const published = [];
    const ingress = new OrderedPublicationIngress({ stream, sink: { publish: (event) => published.push(event) }, permission: unusedPermission });
    const valid = frame(1, { type: 'rows', rows: [] });
    for (const sequence of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => ingress.receive({ ...valid, sequence })).toThrow('Invalid producer sequence');
    }
    expect(published).toEqual([]);
    expect(ingress.receive(valid).kind).toBe('ack');
  });

  test('an uncertain commit retires only its exact stream and never retries publication', () => {
    let calls = 0;
    const ingress = new OrderedPublicationIngress({
      stream, permission: unusedPermission,
      sink: { publish() { calls += 1; throw new Error('synthetic uncertain commit'); } },
    });
    const output = frame(1, { type: 'rows', rows: [] });
    expect(() => ingress.receive(output)).toThrow('uncertain commit');
    expect(ingress.acceptedSequence).toBe(0);
    expect(ingress.receive(output)).toEqual({ kind: 'retired' });
    expect(calls).toBe(1);
  });

  test('decoding failure leaves the unpublished sequence available without guessing a commit outcome', () => {
    const published = [];
    let mismatched = true;
    const ingress = new OrderedPublicationIngress({
      stream, sink: { publish: (event) => published.push(event) },
      permission: (_handle, _runId, permissionOccurrenceId) => ({
        permissionOccurrenceId: mismatched ? 'wrong-occurrence' : permissionOccurrenceId, async respond() {},
      }),
    });
    const output = frame(1, {
      type: 'permission', runId: 'run-a',
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [] },
      decision: { permissionOccurrenceId: occurrence, async respond() {} },
    });
    expect(() => ingress.receive(output)).toThrow('Mismatched permission');
    expect(ingress.acceptedSequence).toBe(0);
    expect(published).toEqual([]);
    mismatched = false;
    expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    expect(published).toHaveLength(1);
  });

  test('checks every stream identity dimension without retiring the current stream', () => {
    let calls = 0;
    const ingress = new OrderedPublicationIngress({ stream, sink: { publish() { calls += 1; } }, permission: unusedPermission });
    for (const field of Object.keys(stream)) {
      expect(ingress.receive(frame(1, { type: 'rows', rows: [] }, { ...stream, [field]: 'replacement' })))
        .toEqual({ kind: 'stale-stream' });
    }
    expect(calls).toBe(0);
    expect(ingress.receive(frame(1, { type: 'rows', rows: [] })).kind).toBe('ack');
    expect(calls).toBe(1);
    ingress.retire();
    expect(ingress.receive(frame(2, { type: 'rows', rows: [] }))).toEqual({ kind: 'retired' });
  });

  test('reconstructs the nested permission tool and exact capability only once before publication', async () => {
    const decisions = [];
    const published = [];
    const responses = [];
    const capability = { permissionOccurrenceId: occurrence, async respond(value) { responses.push([this, value]); } };
    const ingress = new OrderedPublicationIngress({
      stream, sink: { publish: (event) => published.push(event) },
      permission: (...identity) => { decisions.push(identity); return capability; },
    });
    const output = frame(1, {
      type: 'permission', runId: 'run-a',
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] },
      decision: capability,
    });
    expect(ingress.receive(output).kind).toBe('ack');
    expect(published[0].lifecycle.requestedTool).toBeInstanceOf(BashToolUseMessage);
    expect(published[0].decision.permissionOccurrenceId).toBe(capability.permissionOccurrenceId);
    expect(Object.isFrozen(published[0].decision)).toBeTrue();
    await published[0].decision.respond({ optionId: 'allow' });
    expect(responses).toEqual([[capability, { optionId: 'allow' }]]);
    expect(ingress.receive(output).kind).toBe('ack');
    expect(decisions).toEqual([['decision-a', 'run-a', occurrence]]);
    expect(published).toHaveLength(1);
  });

  test('replays historical permissions even when their exact response occurrence has expired', async () => {
    const published = [];
    const ingress = new OrderedPublicationIngress({
      stream, sink: { publish: (event) => published.push(event) },
      permission: (_handle, _runId, permissionOccurrenceId) => ({
        permissionOccurrenceId, async respond() { throw new Error('Permission occurrence is no longer actionable'); },
      }),
    });
    const output = frame(1, {
      type: 'permission', runId: 'retired-run',
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] },
      decision: { permissionOccurrenceId: occurrence, async respond() {} },
    });
    expect(ingress.receive(output)).toMatchObject({ kind: 'ack', ack: { throughSequence: 1 } });
    await expect(published[0].decision.respond({ allow: true })).rejects.toThrow('no longer actionable');
    expect(ingress.receive(frame(2, { type: 'rows', rows: [{ message: new AssistantMessage(at, 'later history') }] })).kind).toBe('ack');
    expect(published).toHaveLength(2);
    expect(ingress.receive(output).kind).toBe('ack');
    expect(published).toHaveLength(2);
  });
});
