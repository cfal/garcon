import { describe, expect, test } from 'bun:test';
import { AssistantMessage, BashToolUseMessage } from '@garcon/common/chat-types';
import type { AgentPermissionResponseCapability, AgentProducerEvent } from '../../contracts/producer.js';
import type { NodePermissionHandleRegistrar, ProducerStreamIdentity } from '../../contracts/node-wire.js';
import {
  decodeWireProducerEvent, encodeWireProducerEvent, MAX_NODE_OUTPUT_BYTES, MAX_NODE_OUTPUT_SEQUENCE,
  parseNodeOutputAck, parseNodeOutputFrame, parseNodeOutputText, parseNodeReplayReply,
  parseProducerStreamIdentity, parseWireProducerEvent, serializeNodeOutputFrame,
} from '../../node-wire.js';

const stream: ProducerStreamIdentity = {
  controllerBootId: 'controller-a', nodeBootId: 'node-a', logicalSessionId: 'logical-a', streamId: 'stream-a',
};
const at = '2026-09-09T00:00:00.000Z';
const permissionOccurrenceId = '00000000-0000-4000-8000-000000000001';
const capability = { permissionOccurrenceId, async respond() {} };
function permissionHandles(createHandle = () => 'decision-a'): NodePermissionHandleRegistrar {
  return { createHandle, register() {} };
}
const events: AgentProducerEvent[] = [
  { type: 'rows', rows: [] },
  { type: 'rows', rows: [{ message: new AssistantMessage(at, 'synthetic output'), providerMeta: { opaque: ['a', 1, null] } }] },
  { type: 'session', session: { agentSessionId: 'native-a', nativeSession: null, nativeSeedReceipt: null } },
  { type: 'session', session: { agentSessionId: 'native-a',
    nativeSession: { ownerId: 'provider-a', schemaVersion: 1, value: { path: '/synthetic/native' } }, nativeSeedReceipt: null } },
  { type: 'notice', runId: 'run-a', content: 'synthetic advisory', title: 'Synthetic title' },
  { type: 'notice', runId: 'run-a', content: '' },
  { type: 'run-ended', runId: 'run-a', outcome: 'finished' },
  { type: 'run-ended', runId: 'run-a', outcome: 'finished', finalResponse: { type: 'text', text: '' } },
  { type: 'run-ended', runId: 'run-a', outcome: 'failed', error: { code: 'SYNTHETIC_FAILURE', message: 'Synthetic failure' } },
  { type: 'run-ended', runId: 'run-a', outcome: 'interrupted' },
  { type: 'permission', runId: 'run-a', lifecycle: {
    kind: 'requested', permissionOccurrenceId, requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'),
    options: [{ id: 'allow', label: 'Allow', scope: 'once' }],
  }, decision: capability },
  { type: 'permission', runId: 'run-a', lifecycle: { kind: 'cancelled', permissionOccurrenceId, reason: null } },
  { type: 'permission', runId: 'run-a', lifecycle: { kind: 'expired', permissionOccurrenceId } },
];

describe('node output wire contract', () => {
  test.each(events)('round-trips normalized $type events without functions or native object handles', async (event) => {
    const wire = encodeWireProducerEvent(event, {
      createHandle: () => 'decision-a',
      register(handle, decision, runId) {
        expect(handle).toBe('decision-a');
        expect(decision.permissionOccurrenceId).toBe(capability.permissionOccurrenceId);
        expect(Object.isFrozen(decision)).toBeTrue();
        expect(runId).toBe('run-a');
      },
    });
    const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: wire });
    const parsed = parseNodeOutputText(serialized);
    expect(parsed).not.toBeNull();
    const responses: unknown[] = [];
    const responseCapability: AgentPermissionResponseCapability = { permissionOccurrenceId, async respond(response) {
      responses.push([this, response]);
    } };
    const decoded = decodeWireProducerEvent(parsed!.event, (handle, runId, occurrence) => {
      expect([handle, runId, occurrence]).toEqual(['decision-a', 'run-a', permissionOccurrenceId]);
      return responseCapability;
    });
    expect(eventData(decoded)).toEqual(eventData(event));
    if (decoded.type === 'permission' && decoded.decision) {
      expect(Object.isFrozen(decoded.decision)).toBeTrue();
      await decoded.decision.respond({ optionId: 'allow' });
      expect(responses).toEqual([[responseCapability, { optionId: 'allow' }]]);
    }
    expect(serialized).not.toContain('respond');
  });

  test('serialized output cannot change when the producing objects are mutated', () => {
    const message = new AssistantMessage(at, 'original');
    const providerMeta = { nested: { value: 'original' } };
    const wire = encodeWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta }] }, permissionHandles());
    const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: wire });
    message.content = 'changed';
    providerMeta.nested.value = 'changed';
    expect(parseNodeOutputText(serialized)?.event).toMatchObject({ rows: [{
      message: { content: 'original' }, providerMeta: { nested: { value: 'original' } },
    }] });
    expect(wire).toMatchObject({ rows: [{
      message: { content: 'original' }, providerMeta: { nested: { value: 'original' } },
    }] });
  });

  test('encoded native references and permission option interiors are independent snapshots', () => {
    const nativeValue = { nested: { path: '/synthetic/original' } };
    const session = encodeWireProducerEvent({ type: 'session', session: {
      agentSessionId: 'native-a', nativeSession: { ownerId: 'provider-a', schemaVersion: 1, value: nativeValue },
      nativeSeedReceipt: null,
    } }, permissionHandles());
    nativeValue.nested.path = '/synthetic/changed';
    expect(session).toMatchObject({ session: { nativeSession: { value: { nested: { path: '/synthetic/original' } } } } });

    const option = { id: 'allow', label: 'Allow', nested: { scope: ['original'] } };
    const permission = encodeWireProducerEvent({ type: 'permission', runId: 'run-a', lifecycle: {
      kind: 'requested', permissionOccurrenceId, requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [option],
    }, decision: capability }, permissionHandles());
    option.nested.scope[0] = 'changed';
    expect(permission).toMatchObject({ lifecycle: { options: [{ nested: { scope: ['original'] } }] } });
  });

  test('snapshots each metadata getter before validating rows, sessions and permission options', () => {
    const inputs: ((metadata: { readonly value: string | number }) => AgentProducerEvent)[] = [
      (providerMeta) => ({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'synthetic'), providerMeta }] }),
      (value) => ({ type: 'session', session: {
        agentSessionId: 'native-a', nativeSession: { ownerId: 'provider-a', schemaVersion: 1, value }, nativeSeedReceipt: null,
      } }),
      (nested) => ({ type: 'permission', runId: 'run-a', lifecycle: {
        kind: 'requested', permissionOccurrenceId, requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'),
        options: [{ id: 'allow', label: 'Allow', nested }],
      }, decision: capability }),
    ];
    for (const input of inputs) {
      let reads = 0;
      const metadata = { get value() { reads += 1; return reads === 1 ? 'safe' : Infinity; } };
      const encoded = encodeWireProducerEvent(input(metadata), permissionHandles());
      expect(reads).toBe(1);
      const expected = encodeWireProducerEvent(input({ value: 'safe' }), permissionHandles());
      expect(encoded).toEqual(expected);
      const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: encoded });
      expect(parseNodeOutputText(serialized)?.event).toEqual(expected);
      expect(reads).toBe(1);
    }
  });

  test('requires canonical row and permission-tool JSON without coercion or extra fields', () => {
    for (const message of [
      { type: 'assistant-message', timestamp: at },
      { type: 'assistant-message', timestamp: at, content: 42 },
      { type: 'assistant-message', timestamp: at, content: 'synthetic', providerNativeRequestId: 'must-not-cross' },
    ]) expect(parseWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta: null }] })).toBeNull();

    const requested = events.find((event) => event.type === 'permission' && event.lifecycle.kind === 'requested')!;
    const wire = encodeWireProducerEvent(requested, permissionHandles());
    if (wire.type !== 'permission' || wire.lifecycle.kind !== 'requested') throw new Error('Expected permission fixture');
    const tool = wire.lifecycle.requestedTool;
    for (const requestedTool of [
      { type: 'bash-tool-use', timestamp: at, toolId: 'tool-a' },
      { ...tool, command: 42 }, { ...tool, providerNativeRequestId: 'must-not-cross' },
    ]) expect(parseWireProducerEvent({ ...wire, lifecycle: { ...wire.lifecycle, requestedTool } })).toBeNull();

    const reordered = Object.fromEntries(Object.entries(tool).reverse());
    expect(parseWireProducerEvent({ ...wire, lifecycle: { ...wire.lifecycle, requestedTool: reordered } })).toEqual(wire);
  });

  test('rejects non-plain JSON values, including hidden custom serialization', () => {
    const message = JSON.parse(JSON.stringify(new AssistantMessage(at, 'synthetic')));
    class Metadata { value = 'synthetic'; }
    const hiddenSerializer = Object.defineProperty({}, 'toJSON', { value: () => 'not an object' });
    const arraySerializer = Object.assign([1, 2], { toJSON: () => 'substituted' });
    const hiddenArraySerializer = Object.defineProperty([1, 2], 'toJSON', { value: () => ['substituted'] });
    for (const providerMeta of [new Date(at), new Map(), new Set(), new Metadata(), hiddenSerializer,
      { nested: new Date(at) }, { toJSON: () => ({ changed: true }) },
      { list: arraySerializer }, { list: hiddenArraySerializer }]) {
      expect(parseWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta }] })).toBeNull();
      const invalid = { type: 'rows', rows: [{ message: new AssistantMessage(at, 'synthetic'), providerMeta }] };
      expect(() => encodeWireProducerEvent(invalid as AgentProducerEvent, permissionHandles())).toThrow();
    }
    expect(parseWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta: Object.create(null) }] })).not.toBeNull();
  });

  test('rejects hidden frame serializers without invoking them', () => {
    const frame = { type: 'node-output', stream, sequence: 1, event: { type: 'rows', rows: [] } } as const;
    let calls = 0;
    Object.defineProperty(frame, 'toJSON', { value: () => { calls += 1; return { ...frame, sequence: -1 }; } });
    expect(() => serializeNodeOutputFrame(frame)).toThrow('custom serialization');
    expect(calls).toBe(0);
  });

  test('rejects hidden message serializers before displaying or registering substituted permission details', () => {
    for (const permission of [false, true]) {
      let serializers = 0;
      let handles = 0;
      const message = permission ? new BashToolUseMessage(at, 'tool-a', 'original') : new AssistantMessage(at, 'original');
      Object.defineProperty(message, 'toJSON', { value: () => {
        serializers += 1;
        return { ...message, ...(permission ? { command: 'substituted' } : { content: 'substituted' }) };
      } });
      const event: AgentProducerEvent = message.type === 'bash-tool-use'
        ? { type: 'permission', runId: 'run-a', lifecycle: {
          kind: 'requested', permissionOccurrenceId, requestedTool: message, options: [],
        }, decision: capability }
        : { type: 'rows', rows: [{ message }] };
      expect(() => encodeWireProducerEvent(event, permissionHandles(() => { handles += 1; return 'decision-a'; }))).toThrow('custom serialization');
      expect([serializers, handles]).toEqual([0, 0]);
    }
  });

  test('captures unknown-object inputs before validating their permission, session and envelope fields', () => {
    const permission = encodeWireProducerEvent(events[10]!, permissionHandles());
    const cases: { parse: (value: unknown) => unknown; value: Record<string, unknown> }[] = [
      ...[permission, events[11], events[12], events[2], events[3], events[4], events[8]].map((value) => ({
        parse: parseWireProducerEvent, value: value as Record<string, unknown>,
      })),
      { parse: parseProducerStreamIdentity, value: stream as unknown as Record<string, unknown> },
      { parse: parseNodeOutputFrame, value: { type: 'node-output', stream, sequence: 1, event: permission } },
      { parse: parseNodeOutputAck, value: { type: 'node-output-ack', stream, throughSequence: 1 } },
      { parse: parseNodeReplayReply, value: { type: 'node-replay-ready', stream, afterSequence: 0, throughSequence: 1 } },
      { parse: parseNodeReplayReply, value: { type: 'node-replay-gap', stream, requestedAfter: 0,
        firstRetainedSequence: 2, lastProducedSequence: 1 } },
    ];
    for (const { parse, value } of cases) {
      const reads: number[] = [];
      const guarded = changingGetters(value, reads);
      expect(parse(guarded)).toEqual(parse(value));
      expect(reads.every((count) => count === 1)).toBeTrue();
    }
  });

  test('serializes and validates one captured frame rather than rereading live getters', () => {
    let sequenceReads = 0;
    let metadataReads = 0;
    const frame = { type: 'node-output', stream,
      get sequence() { sequenceReads += 1; return sequenceReads === 1 ? 1 : -1; },
      event: { type: 'rows', rows: [{
        message: JSON.parse(JSON.stringify(new AssistantMessage(at, 'synthetic'))),
        providerMeta: { get value() { metadataReads += 1; return metadataReads === 1 ? 'safe' : Infinity; } },
      }] },
    } as const;
    const serialized = serializeNodeOutputFrame(frame);
    expect(parseNodeOutputText(serialized)).toMatchObject({
      sequence: 1, event: { rows: [{ providerMeta: { value: 'safe' } }] },
    });
    expect([sequenceReads, metadataReads]).toEqual([1, 1]);
  });

  test('rejects cyclic and over-nested metadata without invoking JSON serialization', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 101; depth += 1) nested = { nested };
    for (const providerMeta of [cyclic, nested]) {
      const event = { type: 'rows', rows: [{ message: new AssistantMessage(at, 'synthetic'), providerMeta }] };
      expect(() => encodeWireProducerEvent(event as AgentProducerEvent, permissionHandles())).toThrow('nesting limit');
    }
  });

  test('rejects malformed envelopes, unsafe sequences and unknown events', () => {
    const valid = { type: 'node-output', stream, sequence: 1, event: { type: 'rows', rows: [] } };
    for (const value of [
      { ...valid, unknown: true }, { ...valid, stream: { ...stream, token: 'extra' } },
      ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN].map((sequence) => ({ ...valid, sequence })),
      { ...valid, event: { type: 'new-provider-event' } },
    ]) expect(parseNodeOutputFrame(value)).toBeNull();
    expect(parseNodeOutputText('{invalid')).toBeNull();
    expect(parseNodeOutputText(' '.repeat(MAX_NODE_OUTPUT_BYTES + 1))).toBeNull();
  });

  test('rejects oversized normalized output instead of truncating its body', () => {
    expect(() => {
      const event = encodeWireProducerEvent({ type: 'rows', rows: [{
        message: new AssistantMessage(at, 'a'.repeat(MAX_NODE_OUTPUT_BYTES)),
      }] }, permissionHandles());
      serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event });
    }).toThrow('frame limit');
  });

  test('rejects serialized UTF-8 bytes over the frame bound after encoding under the character budget', () => {
    const event = encodeWireProducerEvent({ type: 'rows', rows: [{
      message: new AssistantMessage(at, '\u754c'.repeat(Math.ceil(MAX_NODE_OUTPUT_BYTES / 3))),
    }] }, permissionHandles());
    expect(event.type).toBe('rows');
    expect(parseNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event }) === null).toBeTrue();
    expect(() => serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event })).toThrow('frame limit');
  });

  test('decoding owns all fields before validating or resolving a permission capability', () => {
    for (const event of events) {
      const wire = encodeWireProducerEvent(event, permissionHandles());
      const reads: number[] = [];
      const guarded = changingGetters(wire, reads) as typeof wire;
      expect(eventData(decodeWireProducerEvent(guarded, () => capability)))
        .toEqual(eventData(decodeWireProducerEvent(wire, () => capability)));
      expect(reads.every((count) => count === 1)).toBeTrue();
    }
  });

  test('consumer mutations cannot alter wire metadata or permission options', () => {
    const row = encodeWireProducerEvent({ type: 'rows', rows: [{
      message: new AssistantMessage(at, 'synthetic'), providerMeta: { nested: { value: 'original' } },
    }] }, permissionHandles());
    const permission = encodeWireProducerEvent(events[10]!, permissionHandles());
    for (const wire of [row, permission]) {
      const before = JSON.stringify(wire);
      const decoded = decodeWireProducerEvent(wire, () => capability);
      if (decoded.type === 'rows') Object.assign(decoded.rows[0]!.providerMeta!.nested!, { value: 'changed' });
      if (decoded.type === 'permission' && decoded.lifecycle.kind === 'requested') {
        Object.assign(decoded.lifecycle.options[0]!, { label: 'Changed' });
      }
      expect(JSON.stringify(wire)).toBe(before);
    }
  });

  test('decoding pins the resolved occurrence and response method once', async () => {
    const reads = { occurrence: 0, respond: 0 };
    const responses: unknown[] = [];
    const responseCapability = {
      get permissionOccurrenceId() { return ++reads.occurrence === 1 ? permissionOccurrenceId : 'changed'; },
      get respond() {
        reads.respond += 1;
        return async (response: unknown) => { responses.push(response); };
      },
    };
    const decoded = decodeWireProducerEvent(encodeWireProducerEvent(events[10]!, permissionHandles()), () => responseCapability);
    if (decoded.type !== 'permission' || !decoded.decision) throw new Error('Expected permission fixture');
    expect(decoded.decision.permissionOccurrenceId).toBe(permissionOccurrenceId);
    await decoded.decision.respond({ optionId: 'allow' });
    expect(responses).toEqual([{ optionId: 'allow' }]);
    expect(reads).toEqual({ occurrence: 1, respond: 1 });
  });

  test('serializes the validated envelope with deterministic field order', () => {
    const frame = { type: 'node-output', stream, sequence: 1, event: { type: 'rows', rows: [] } } as const;
    const reordered = Object.fromEntries(Object.entries(frame).reverse()) as unknown as typeof frame;
    expect(serializeNodeOutputFrame(reordered)).toBe(serializeNodeOutputFrame(frame));
  });

  test('stops inspecting wide object properties as soon as the snapshot budget is exhausted', () => {
    const names = Array.from({ length: 50_000 }, (_, index) => `field${index}${'x'.repeat(1024)}`);
    let descriptors = 0;
    const providerMeta = new Proxy({}, {
      ownKeys: () => names,
      getOwnPropertyDescriptor: () => { descriptors += 1; return { enumerable: true, configurable: true }; },
      get: (_target, key) => key === 'toJSON' ? undefined : 1,
    });
    expect(parseWireProducerEvent({ type: 'rows', rows: [{
      message: { type: 'assistant-message', timestamp: at, content: 'synthetic' }, providerMeta,
    }] })).toBeNull();
    expect(descriptors).toBeLessThan(names.length);
  });

  test('rejects unknown envelope fields without traversing the remaining payload', () => {
    let reads = 0;
    const event = Object.assign({ type: 'rows', extra: 'invalid', rows: [] }, Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`extra${index}`, undefined]),
    ));
    Object.defineProperty(event, 'last', { enumerable: true, get() { reads += 1; throw new Error('Unbounded envelope capture'); } });
    expect(() => encodeWireProducerEvent(event as AgentProducerEvent, permissionHandles())).toThrow('Invalid normalized provider output');
    expect(reads).toBe(0);
  });

  test('rejects non-JSON metadata, malformed sessions and impossible terminal fields', () => {
    const message = JSON.parse(JSON.stringify(new AssistantMessage(at, 'synthetic')));
    for (const providerMeta of [{ fn() {} }, { value: Infinity }, { value: undefined }]) {
      expect(parseWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta }] })).toBeNull();
    }
    for (const event of [
      { type: 'rows', rows: [{ message: { type: 'unknown', timestamp: at }, providerMeta: null }] },
      { type: 'session', session: { agentSessionId: '', nativeSession: null, nativeSeedReceipt: null } },
      { type: 'run-ended', runId: 'run-a', outcome: 'finished', error: { code: 'FAILED' } },
      { type: 'run-ended', runId: 'run-a', outcome: 'failed', finalResponse: { type: 'text', text: 'invalid' } },
      { type: 'run-ended', outcome: 'finished' },
    ]) expect(parseWireProducerEvent(event)).toBeNull();
  });

  test('requires the exact permission occurrence and a serialized nested tool', () => {
    const requested = events.find((event) => event.type === 'permission' && event.lifecycle.kind === 'requested')!;
    const wire = encodeWireProducerEvent(requested, permissionHandles());
    expect(parseWireProducerEvent({ ...wire, decision: capability })).toBeNull();
    expect(parseWireProducerEvent({ ...wire, decisionHandle: undefined })).toBeNull();
    if (wire.type !== 'permission') throw new Error('Expected permission fixture');
    expect(parseWireProducerEvent({ ...wire, lifecycle: { ...wire.lifecycle, permissionOccurrenceId: 'native-request-id' } })).toBeNull();
    expect(parseWireProducerEvent({ ...wire, lifecycle: { ...wire.lifecycle, requestedTool: new AssistantMessage(at, 'not a tool') } })).toBeNull();
    expect(() => decodeWireProducerEvent(wire, () => ({ ...capability, permissionOccurrenceId: 'wrong' }))).toThrow('Mismatched');
    expect(() => encodeWireProducerEvent({ ...requested, decision: { ...capability, permissionOccurrenceId: 'wrong' } } as AgentProducerEvent,
      permissionHandles())).toThrow('exact response');
  });

  test('captures a requested occurrence, run and response before registering its handle', async () => {
    const reads = { type: 0, run: 0, lifecycle: 0, occurrence: 0, decision: 0, capability: 0, respond: 0 };
    const otherOccurrence = '00000000-0000-4000-8000-000000000002';
    const responses: unknown[] = [];
    const decision = {
      get permissionOccurrenceId() { return ++reads.capability === 1 ? permissionOccurrenceId : otherOccurrence; },
      get respond() {
        reads.respond += 1;
        return async (response: unknown) => { responses.push(response); };
      },
    };
    const lifecycle = {
      kind: 'requested' as const,
      get permissionOccurrenceId() { return ++reads.occurrence === 1 ? permissionOccurrenceId : otherOccurrence; },
      requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'), options: [{ id: 'allow', label: 'Allow' }],
    };
    const event = {
      get type() { reads.type += 1; return 'permission' as const; },
      get runId() { return ++reads.run === 1 ? 'run-a' : 'run-b'; },
      get lifecycle() { return ++reads.lifecycle === 1 ? lifecycle : { ...lifecycle, permissionOccurrenceId: otherOccurrence }; },
      get decision() { return ++reads.decision === 1 ? decision : { ...capability, permissionOccurrenceId: otherOccurrence }; },
    };
    let registered: AgentPermissionResponseCapability | undefined;
    const encoded = encodeWireProducerEvent(event, {
      createHandle: () => 'decision-a',
      register(handle, response, runId) {
        registered = response;
        expect(handle).toBe('decision-a');
        expect(runId).toBe('run-a');
        expect(response.permissionOccurrenceId).toBe(permissionOccurrenceId);
      },
    });
    expect(encoded).toMatchObject({ type: 'permission', runId: 'run-a', decisionHandle: 'decision-a',
      lifecycle: { permissionOccurrenceId } });
    expect(reads).toEqual({ type: 1, run: 1, lifecycle: 1, occurrence: 1, decision: 1, capability: 1, respond: 1 });
    expect(Object.isFrozen(registered)).toBeTrue();
    await registered!.respond({ optionId: 'allow' });
    expect(responses).toEqual([{ optionId: 'allow' }]);
  });

  test('invalid permission output allocates no response handle', () => {
    let handles = 0;
    const event = { type: 'permission', runId: 'run-a', lifecycle: {
      kind: 'requested', permissionOccurrenceId, requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'),
      options: [{ id: '', label: 'Invalid option' }],
    }, decision: capability } as const;
    expect(() => encodeWireProducerEvent(event, permissionHandles(() => { handles += 1; return 'decision-a'; })))
      .toThrow('Invalid normalized provider output');
    expect(handles).toBe(0);
  });

  test('rejects invalid permission handles without registering live authority', () => {
    for (const candidate of ['', 'bad handle', '_invalid', 'a'.repeat(129), 42, null, undefined]) {
      const registered: AgentPermissionResponseCapability[] = [];
      const candidateCalls: unknown[][] = [];
      expect(() => encodeWireProducerEvent(events[10]!, {
        createHandle(...args: unknown[]) {
          candidateCalls.push(args);
          return candidate as string;
        },
        register(_handle, decision) { registered.push(decision); },
      })).toThrow('Invalid permission decision handle');
      expect(candidateCalls).toEqual([[]]);
      expect(registered).toEqual([]);
    }
  });

  test('rejects permission frames over the UTF-8 or snapshot limit before allocating a handle', () => {
    const excessiveLength = new Proxy([], { get(target, property, receiver) {
      return property === 'length' ? MAX_NODE_OUTPUT_BYTES + 1 : Reflect.get(target, property, receiver);
    } });
    const payloads = [
      { payload: '\u754c'.repeat(Math.ceil(MAX_NODE_OUTPUT_BYTES / 3)), error: 'frame limit' },
      { payload: excessiveLength, error: 'snapshot value limit' },
    ];
    for (const { payload, error } of payloads) {
      let handles = 0;
      const event: AgentProducerEvent = { type: 'permission', runId: 'run-a', lifecycle: {
        kind: 'requested', permissionOccurrenceId, requestedTool: new BashToolUseMessage(at, 'tool-a', 'pwd'),
        options: [{ id: 'allow', label: 'Allow', payload }],
      }, decision: capability };
      expect(() => { encodeWireProducerEvent(event, permissionHandles(() => { handles += 1; return 'decision-a'; })); }).toThrow(error);
      expect(handles).toBe(0);
    }
  });

  test('a preflighted permission fits the largest legal stream identities, sequence and handle', () => {
    const identity = 'x'.repeat(128);
    const event = encodeWireProducerEvent(events[10]!, permissionHandles(() => identity));
    const text = serializeNodeOutputFrame({ type: 'node-output', sequence: MAX_NODE_OUTPUT_SEQUENCE, event,
      stream: { controllerBootId: identity, nodeBootId: identity, logicalSessionId: identity, streamId: identity },
    });
    expect(parseNodeOutputText(text)?.event).toEqual(event);
  });

  test('captured permission methods ignore overridden bind properties during encode and decode', async () => {
    for (const encode of [true, false]) {
      const responses: unknown[] = [];
      let binds = 0;
      const responseCapability: AgentPermissionResponseCapability = {
        permissionOccurrenceId,
        async respond(response) { responses.push([this, response]); },
      };
      Object.defineProperty(responseCapability.respond, 'bind', { value: () => { binds += 1; return 42; } });
      let captured: AgentPermissionResponseCapability | undefined;
      if (encode) {
        const requested = events[10]!;
        encodeWireProducerEvent({ ...requested, decision: responseCapability } as AgentProducerEvent, {
          createHandle: () => 'decision-a',
          register(_handle, decision) { captured = decision; },
        });
      } else {
        const decoded = decodeWireProducerEvent(encodeWireProducerEvent(events[10]!, permissionHandles()), () => responseCapability);
        if (decoded.type === 'permission') captured = decoded.decision;
      }
      expect(typeof captured?.respond).toBe('function');
      await captured!.respond({ optionId: 'allow' });
      expect(responses).toEqual([[responseCapability, { optionId: 'allow' }]]);
      expect(binds).toBe(0);
    }
  });

  test('bounds inherited enumerable properties on messages and nested permission tools', () => {
    const prototype = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`inherited${index}${'x'.repeat(1024)}`, null]));
    for (const permission of [false, true]) {
      const tool = new BashToolUseMessage(at, 'tool-a', 'pwd');
      const message = permission ? tool : new AssistantMessage(at, 'synthetic');
      Object.setPrototypeOf(message, prototype);
      let handles = 0;
      const event: AgentProducerEvent = permission
        ? { type: 'permission', runId: 'run-a', lifecycle: {
          kind: 'requested', permissionOccurrenceId, requestedTool: tool, options: [],
        }, decision: capability }
        : { type: 'rows', rows: [{ message }] };
      expect(() => encodeWireProducerEvent(event, permissionHandles(() => { handles += 1; return 'decision-a'; }))).toThrow('frame limit');
      expect(handles).toBe(0);
    }
  });

  test('bounds shared subtrees inside row messages and requested tools before serialization', () => {
    for (const permission of [false, true]) {
      let leaves = 0;
      let nested: Record<string, unknown> = { get leaf() {
        if (++leaves > 100_000) throw new Error('Unbounded message traversal');
        return 'synthetic'.repeat(1024);
      } };
      for (let depth = 0; depth < 30; depth += 1) nested = { left: nested, right: nested };
      const message = permission ? new BashToolUseMessage(at, 'tool-a', 'pwd') : new AssistantMessage(at, 'synthetic');
      Object.assign(message, { nested });
      const event: AgentProducerEvent = message.type === 'bash-tool-use'
        ? { type: 'permission', runId: 'run-a', lifecycle: {
          kind: 'requested', permissionOccurrenceId, requestedTool: message, options: [],
        }, decision: capability }
        : { type: 'rows', rows: [{ message }] };
      let handles = 0;
      expect(() => encodeWireProducerEvent(event, permissionHandles(() => { handles += 1; return 'decision-a'; }))).toThrow('frame limit');
      expect(handles).toBe(0);
      expect(leaves).toBeLessThan(100_000);
    }
  });

  test('shares the snapshot work budget across all messages in an event', () => {
    let leaves = 0;
    const nested = Array.from({ length: 20_000 }, () => ({ get leaf() {
      if (++leaves > 150_000) throw new Error('Per-message budget escaped its event');
      return 'synthetic'.repeat(16);
    } }));
    const rows = Array.from({ length: 20 }, () => ({
      message: Object.assign(new AssistantMessage(at, 'synthetic'), { nested }),
    }));
    expect(() => encodeWireProducerEvent({ type: 'rows', rows }, permissionHandles())).toThrow('frame limit');
    expect(leaves).toBeLessThan(150_000);
  });

  test('bounds expanded shared subtrees before serializing them', () => {
    for (const encode of [true, false]) {
      let leaves = 0;
      let providerMeta = { get leaf() {
        if (++leaves > 100_000) throw new Error('Unbounded snapshot traversal');
        return 'synthetic'.repeat(1024);
      } } as Record<string, unknown>;
      for (let depth = 0; depth < 30; depth += 1) providerMeta = { left: providerMeta, right: providerMeta };
      const message = new AssistantMessage(at, 'synthetic');
      expect(() => encode
        ? encodeWireProducerEvent({ type: 'rows', rows: [{ message, providerMeta }] } as AgentProducerEvent, permissionHandles())
        : serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1,
          event: { type: 'rows', rows: [{ message: JSON.parse(JSON.stringify(message)), providerMeta }] },
        } as Parameters<typeof serializeNodeOutputFrame>[0]))
        .toThrow('frame limit');
      expect(leaves).toBeLessThan(100_000);
    }
  });

  test('omits type-legal absent terminal properties while retaining strict serialized fields', () => {
    const outputs: AgentProducerEvent[] = [
      { type: 'run-ended', runId: 'run-a', outcome: 'finished', error: undefined },
      { type: 'run-ended', runId: 'run-a', outcome: 'failed', finalResponse: undefined },
      { type: 'run-ended', runId: 'run-a', outcome: 'interrupted', error: undefined, finalResponse: undefined },
      { type: 'permission', runId: 'run-a', lifecycle: { kind: 'expired', permissionOccurrenceId }, decision: undefined },
    ];
    for (const output of outputs) {
      const encoded = encodeWireProducerEvent(output, permissionHandles());
      expect(encoded).toEqual(JSON.parse(JSON.stringify(output)));
      const serialized = serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: encoded });
      expect(parseNodeOutputText(serialized)?.event).toEqual(encoded);
      expect(parseWireProducerEvent({ ...encoded, extra: null })).toBeNull();
    }
  });

  test('native seed receipts reject fields outside their canonical contract before serialization', () => {
    const nativeSeedReceipt = {
      agentSessionId: 'native-a', placement: 'user-prefix', format: 'v3-xml', codeUnitLength: 1, sha256: 'a'.repeat(64),
    } as const;
    const event = { type: 'session', session: { agentSessionId: 'native-a', nativeSession: null, nativeSeedReceipt } } as const;
    expect(parseWireProducerEvent(event)).toEqual(event);
    const malformed = { ...event, session: { ...event.session, nativeSeedReceipt: { ...nativeSeedReceipt, extra: 'must-not-cross' } } };
    expect(parseWireProducerEvent(malformed)).toBeNull();
    expect(() => serializeNodeOutputFrame({ type: 'node-output', stream, sequence: 1, event: malformed })).toThrow();
  });

  test('strictly validates ACK and replay watermarks including an entirely pruned stream', () => {
    expect(parseNodeOutputAck({ type: 'node-output-ack', stream, throughSequence: 0 })).not.toBeNull();
    expect(parseNodeOutputAck({ type: 'node-output-ack', stream, throughSequence: -1 })).toBeNull();
    expect(parseNodeReplayReply({ type: 'node-replay-ready', stream, afterSequence: 4, throughSequence: 3 })).toBeNull();
    const gap = { type: 'node-replay-gap', stream, requestedAfter: 1, firstRetainedSequence: 4, lastProducedSequence: 3 };
    expect(parseNodeReplayReply(gap)).toEqual(gap);
    expect(parseNodeReplayReply({ ...gap, firstRetainedSequence: 5 })).toBeNull();
    expect(parseNodeReplayReply({ ...gap, firstRetainedSequence: 2 })).toBeNull();
    const lastGap = { ...gap, requestedAfter: MAX_NODE_OUTPUT_SEQUENCE - 1,
      firstRetainedSequence: Number.MAX_SAFE_INTEGER, lastProducedSequence: MAX_NODE_OUTPUT_SEQUENCE };
    expect(parseNodeReplayReply(lastGap)).toEqual(lastGap);
    expect(parseNodeOutputAck({ type: 'node-output-ack', stream, throughSequence: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(parseNodeReplayReply({ ...lastGap, lastProducedSequence: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(parseNodeReplayReply({ type: 'node-replay-ready', stream,
      afterSequence: MAX_NODE_OUTPUT_SEQUENCE, throughSequence: Number.MAX_SAFE_INTEGER })).toBeNull();
  });
});

function eventData(event: AgentProducerEvent): unknown {
  return event.type === 'permission' && event.decision
    ? { ...event, decision: { permissionOccurrenceId: event.decision.permissionOccurrenceId } }
    : event;
}

function changingGetters(value: unknown, reads: number[]): unknown {
  if (Array.isArray(value)) return value.map((item) => changingGetters(item, reads));
  if (value === null || typeof value !== 'object') return value;
  return Object.defineProperties({}, Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const captured = changingGetters(child, reads);
    const index = reads.push(0) - 1;
    return [key, { enumerable: true, get() { return ++reads[index]! === 1 ? captured : null; } }];
  })));
}
