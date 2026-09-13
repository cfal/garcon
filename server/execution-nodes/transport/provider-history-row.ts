import { types } from 'node:util';
import { NodeHistoryMemoryBudget } from './provider-history-memory.js';
import { isNormalizedJsonObject, snapshotNormalizedMessage, type AgentImportedTranscriptRow } from '@garcon/server-agent-interface';

export const MAX_NODE_HISTORY_ROW_BYTES = 64 * 1024 * 1024;
export const MAX_NODE_HISTORY_ROW_VALUES = 1024 * 1024;
export const NODE_HISTORY_ROW_ENCODING = 'normalized-history-row-json-v1';

export class NodeHistoryRowError extends Error {
  constructor(readonly code: 'NODE_HISTORY_INVALID' | 'NODE_HISTORY_TOO_LARGE') {
    super(code === 'NODE_HISTORY_INVALID' ? 'Invalid normalized history row' : 'Remote history row exceeds its transport limit');
    this.name = 'NodeHistoryRowError';
  }
}

export interface NodeHistoryRowSize {
  readonly byteLength: number;
  readonly values: number;
  readonly stringCodeUnits: number;
}

/** Counts escaped UTF-8 and dense structures before allocating an encoded row. */
export function measureNodeHistoryRow(row: AgentImportedTranscriptRow): NodeHistoryRowSize {
  return new HistoryRowBudget().measure(row);
}

export interface EncodedNodeHistoryRow {
  readonly bytes: Uint8Array;
  release(): void;
}

export function encodeNodeHistoryRow(row: AgentImportedTranscriptRow, memory: NodeHistoryMemoryBudget): EncodedNodeHistoryRow {
  const measured = measureNodeHistoryRow(row);
  const reservation = memory.reserve(historyEncodingBytes(measured));
  try {
    const captured = restoreRow(row);
    const size = measureNodeHistoryRow(captured);
    const text = JSON.stringify(captured);
    if (Buffer.byteLength(text) !== size.byteLength || size.byteLength > measured.byteLength
      || size.values > measured.values || size.stringCodeUnits > measured.stringCodeUnits) throw invalid();
    let bytes: Uint8Array | null = Buffer.from(text);
    reservation.reduceTo(bytes.byteLength);
    return {
      get bytes() { if (!bytes) throw new TypeError('History row encoding was released'); return bytes; },
      release() { bytes?.fill(0); bytes = null; reservation.release(); },
    };
  } catch (error) { reservation.release(); throw error; }
}

/** Returns ownership of the decoded row to the caller; transfer storage remains separately reserved. */
export function decodeNodeHistoryRow(bytes: Uint8Array, memory: NodeHistoryMemoryBudget): AgentImportedTranscriptRow {
  const values = countEncodedValues(bytes);
  // Includes input bytes, UTF-16 text, parsed data, normalized snapshots, and dense object storage.
  const reservation = memory.reserve(7 * bytes.byteLength + 3 * 64 * values);
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    new HistoryRowBudget().measure(value);
    return restoreRow(value);
  } catch (error) {
    if (error instanceof NodeHistoryRowError) throw error;
    throw invalid();
  } finally { reservation.release(); }
}

export function historyEncodingBytes(size: NodeHistoryRowSize): number {
  // Two normalized copies, JSON UTF-16, encoded bytes, and conservative per-value storage.
  return 3 * size.byteLength + 4 * size.stringCodeUnits + 2 * 64 * size.values;
}

/** Counts structure before JSON.parse can allocate a dense object graph. Syntax validation follows. */
function countEncodedValues(bytes: Uint8Array): number {
  if (bytes.byteLength > MAX_NODE_HISTORY_ROW_BYTES) throw oversized();
  let values = 0;
  let depth = 0;
  let string = false;
  let escape = false;
  let token = false;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (string) {
      if (escape) escape = false;
      else if (byte === 92) escape = true;
      else if (byte === 34) string = false;
      continue;
    }
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 44 || byte === 58) { token = false; continue; }
    if (byte === 125 || byte === 93) { depth--; token = false; continue; }
    if (byte === 123 || byte === 91) {
      if (++depth > 101) throw invalid();
      token = false;
    } else if (byte === 34) { string = true; token = false; }
    else if (token) continue;
    else token = true;
    if (++values > MAX_NODE_HISTORY_ROW_VALUES) throw oversized();
  }
  return values;
}

function restoreRow(value: unknown): AgentImportedTranscriptRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (!Object.hasOwn(row, 'message') || Object.keys(row).some((key) => key !== 'message' && key !== 'providerMeta')) throw invalid();
  if (row.providerMeta !== undefined && !isNormalizedJsonObject(row.providerMeta)) throw invalid();
  try {
    const message = snapshotNormalizedMessage(row.message);
    return { message, ...(row.providerMeta === undefined ? {} : { providerMeta: structuredClone(row.providerMeta) }) };
  } catch { throw invalid(); }
}

class HistoryRowBudget {
  #bytes = 0;
  #values = 0;
  #stringCodeUnits = 0;

  measure(value: unknown): NodeHistoryRowSize {
    this.#visit(value, 0, 'row');
    return { byteLength: this.#bytes, values: this.#values, stringCodeUnits: this.#stringCodeUnits };
  }

  #visit(value: unknown, depth: number, kind: 'row' | 'message' | 'json' = 'json'): void {
    if (++this.#values > MAX_NODE_HISTORY_ROW_VALUES) throw oversized();
    if (depth > 100) throw invalid();
    if (value === null) { this.#add(4); return; }
    if (typeof value === 'string') { this.#string(value); return; }
    if (typeof value === 'boolean') { this.#add(value ? 4 : 5); return; }
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) {
      this.#add(JSON.stringify(value).length); return;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value)) throw invalid();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (kind !== 'message' && prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw invalid();
    if (array) {
      if (value.length > MAX_NODE_HISTORY_ROW_VALUES - this.#values) throw oversized();
      this.#add(2 + Math.max(0, value.length - 1));
      for (let i = 0; i < value.length; i++) this.#visit(dataProperty(value, String(i)), depth + 1);
      if (Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
      return;
    }
    this.#add(2);
    let keys = 0;
    let serialized = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      keys++;
      if (++this.#values > MAX_NODE_HISTORY_ROW_VALUES) throw oversized();
      const child = dataProperty(value, key);
      // Shared message classes use undefined fields for absent optional attributes.
      if (child === undefined && (kind === 'message' || kind === 'row' && key === 'providerMeta')) continue;
      this.#add(serialized++ ? 2 : 1);
      this.#string(key);
      this.#visit(child, depth + 1, kind === 'row' && key === 'message' || kind === 'message' && key === 'requestedTool' ? 'message' : 'json');
    }
    if (Reflect.ownKeys(value).length !== keys) throw invalid();
  }

  #string(value: string): void {
    this.#stringCodeUnits += value.length;
    this.#add(2);
    if (value.length > MAX_NODE_HISTORY_ROW_BYTES - this.#bytes) throw oversized();
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) this.#add(2);
      else if (code < 32) this.#add(6);
      else if (code < 128) this.#add(1);
      else if (code < 2048) this.#add(2);
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        this.#add(4); i++;
      } else this.#add(code >= 0xd800 && code <= 0xdfff ? 6 : 3);
    }
  }

  #add(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > MAX_NODE_HISTORY_ROW_BYTES) throw oversized();
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  return descriptor.value;
}

function invalid(): NodeHistoryRowError { return new NodeHistoryRowError('NODE_HISTORY_INVALID'); }
function oversized(): NodeHistoryRowError { return new NodeHistoryRowError('NODE_HISTORY_TOO_LARGE'); }
