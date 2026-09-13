import { afterEach, expect, mock, test } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, PermissionRequestMessage, ToolResultMessage, UserMessage } from '../../../../common/chat-types.js';
import { decodeNodeHistoryRow, encodeNodeHistoryRow, measureNodeHistoryRow,
  historyEncodingBytes, MAX_NODE_HISTORY_ROW_BYTES, MAX_NODE_HISTORY_ROW_VALUES, type EncodedNodeHistoryRow } from '../provider-history-row.js';

import { NodeHistoryMemoryBudget } from '../provider-history-memory.js';
import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';

const memory = new NodeHistoryMemoryBudget(1024 * 1024 * 1024);
const retained: EncodedNodeHistoryRow[] = [];
afterEach(() => { for (const row of retained.splice(0)) row.release(); expect(memory.reservedBytes).toBe(0); });
function encode(row: AgentImportedTranscriptRow): Uint8Array {
  const encoded = encodeNodeHistoryRow(row, memory); retained.push(encoded); return encoded.bytes;
}
function decode(bytes: Uint8Array): AgentImportedTranscriptRow { return decodeNodeHistoryRow(bytes, memory); }

const at = '2026-01-01T00:00:00.000Z';

test('history row encoding restores shared classes, opaque metadata, and nested requested tools', () => {
  const messages = [new UserMessage(at, 'Synthetic input'), new AssistantMessage(at, 'Synthetic output'),
    new PermissionRequestMessage(at, '11111111-1111-4111-8111-111111111111', new BashToolUseMessage(at, 'synthetic-tool', 'true')),
    new ToolResultMessage(at, 'synthetic-tool', { nested: [null, true, 5, { text: 'synthetic' }] }, false)];
  for (const message of messages) {
    const row = { message, providerMeta: { position: [1, 2], source: 'synthetic' } };
    const encoded = encode(row);
    expect(encoded.byteLength).toBe(measureNodeHistoryRow(row).byteLength);
    const restored = decode(encoded);
    expect(restored).toEqual(row);
    expect(restored.message).toBeInstanceOf(message.constructor);
    if (restored.message instanceof PermissionRequestMessage) expect(restored.message.requestedTool).toBeInstanceOf(BashToolUseMessage);
    row.providerMeta.position.push(3);
    expect(restored.providerMeta?.position).toEqual([1, 2]);
  }
});

test('history byte accounting includes escaping, UTF-8, isolated surrogates, keys and punctuation', () => {
  for (const content of ['"\\\b\t\n\f\r\u0000\u001f', '\u007f\u0080\u07ff\u0800\ud83d\ude00\ud800\udfff', '']) {
    const row = { message: new AssistantMessage(at, content), providerMeta: { [content]: [0, 1e-20, false, null, {}] } };
    expect(measureNodeHistoryRow(row).byteLength).toBe(Buffer.byteLength(JSON.stringify(row)));
    expect(decode(encode(row))).toEqual(row);
  }
});

test('remote history accepts a row larger than the live-output limit without control-frame serialization', () => {
  const row = { message: new AssistantMessage(at, 'x'.repeat(17 * 1024 * 1024)) };
  const encoded = encode(row);
  expect(encoded.byteLength).toBeGreaterThan(16 * 1024 * 1024);
  expect(decode(encoded)).toEqual(row);
});

test('escaped and structurally dense rows fail before encoded allocation', () => {
  const escaped = { message: new AssistantMessage(at, '\u0000'.repeat(Math.ceil(MAX_NODE_HISTORY_ROW_BYTES / 6))) };
  expect(() => encode(escaped)).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_TOO_LARGE' }));
  const dense = { message: new AssistantMessage(at, 'Synthetic'), providerMeta: { values: new Array(MAX_NODE_HISTORY_ROW_VALUES).fill(0) } };
  expect(() => encode(dense)).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_TOO_LARGE' }));
});

test('unsupported normalized data never becomes a dropped row or lossy JSON value', () => {
  const message = new ToolResultMessage(at, 'synthetic-tool', {}, false);
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, new Date(0), new Map(), () => {}, Symbol('synthetic')]) {
    message.content = { value };
    expect(() => encode({ message })).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_INVALID' }));
  }
  for (const value of [{ message: { type: 'assistant-message', timestamp: at, content: 12 } },
    { message: { type: 'assistant-message', timestamp: at, content: 'Synthetic', extra: true } },
    { message: new AssistantMessage(at, 'Synthetic'), providerMeta: null }, { message: null }]) {
    expect(() => decode(Buffer.from(JSON.stringify(value)))).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_INVALID' }));
  }
  expect(() => decode(new Uint8Array([0xff]))).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_INVALID' }));
});

test('preflight rejects accessors and proxies without invoking provider code', () => {
  const read = mock(() => { throw new Error('Synthetic accessor must remain inert'); });
  const message = new AssistantMessage(at, 'Synthetic');
  Object.defineProperty(message, 'content', { get: read, enumerable: true });
  expect(() => encode({ message })).toThrow();
  expect(() => encode(new Proxy({ message }, { get: read, ownKeys: read }))).toThrow();
  expect(read).not.toHaveBeenCalled();
});


test('shared history budget retains encoded rows until disposal and releases failed encoding', () => {
  const row = { message: new AssistantMessage(at, 'Synthetic retained row') };
  const size = measureNodeHistoryRow(row);
  const pool = new NodeHistoryMemoryBudget(historyEncodingBytes(size));
  const first = encodeNodeHistoryRow(row, pool);
  try {
    expect(pool.reservedBytes).toBe(first.bytes.byteLength);
    expect(() => encodeNodeHistoryRow(row, pool)).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  } finally { first.release(); first.release(); }
  expect(pool.reservedBytes).toBe(0);
  expect(() => first.bytes).toThrow('released');
  const malformed = { message: { type: 'assistant-message', timestamp: at, content: 1 } };
  expect(() => decodeNodeHistoryRow(Buffer.from(JSON.stringify(malformed)), memory)).toThrow();
  expect(memory.reservedBytes).toBe(0);
});

test('decoding reserves structure before parsing and cannot borrow occupied encoding capacity', () => {
  const row = { message: new AssistantMessage(at, 'Synthetic'), providerMeta: { values: new Array(100).fill(null) } };
  const pool = new NodeHistoryMemoryBudget(1024);
  const encoded = encode(row);
  expect(() => decodeNodeHistoryRow(encoded, pool)).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  expect(pool.reservedBytes).toBe(0);
  const malformedDense = Buffer.from('[' + '0,'.repeat(MAX_NODE_HISTORY_ROW_VALUES) + ']');
  expect(() => decodeNodeHistoryRow(malformedDense, pool)).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_TOO_LARGE' }));
  expect(pool.reservedBytes).toBe(0);
});

test('encoding refusal precedes normalized snapshot allocation and encoding failures release their reservation', () => {
  const row = { message: new AssistantMessage(at, 'Synthetic') };
  const pool = new NodeHistoryMemoryBudget(1);
  expect(() => encodeNodeHistoryRow(row, pool)).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  expect(pool.reservedBytes).toBe(0);
  Object.assign(row.message, { unexpected: 'Synthetic invalid field' });
  expect(() => encodeNodeHistoryRow(row, memory)).toThrow(expect.objectContaining({ code: 'NODE_HISTORY_INVALID' }));
  expect(memory.reservedBytes).toBe(0);
});
