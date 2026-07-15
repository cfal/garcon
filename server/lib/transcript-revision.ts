import type { ChatMessage, CompactionMessage } from '../../common/chat-types.js';
import {
  getNativeMessageRevisionSource,
  type NativeMessageSource,
} from '../agents/shared/native-message-source.js';

const COMPACTION_REVISION_SOURCE = Symbol('garcon.compactionRevisionSource');

interface AddOptions {
  deferCompactionMetadata?: boolean;
}

export class TranscriptRevisionAccumulator {
  #messageCount = 0;
  #fragmentCount = 0;
  #sumA = 0;
  #sumB = 0;

  add(message: ChatMessage, options: AddOptions = {}): void {
    const source = getNativeMessageRevisionSource(message) ?? { order: this.#messageCount };
    const wireValue = message.type === 'compaction'
      ? compactionWithoutMetadata(message)
      : message;
    this.#addValue('message', wireValue, source);
    this.#messageCount += 1;
    if (message.type === 'compaction' && !options.deferCompactionMetadata) {
      this.addCompactionMetadata(
        message,
        getCompactionRevisionSource(message) ?? source,
      );
    }
  }

  addCompactionMetadata(
    value: Pick<CompactionMessage, 'trigger' | 'preTokens' | 'postTokens'>,
    position: unknown,
  ): void {
    this.#addValue('compaction-metadata', {
      trigger: value.trigger,
      preTokens: value.preTokens,
      postTokens: value.postTokens,
    }, position);
    this.#fragmentCount += 1;
  }

  merge(other: TranscriptRevisionAccumulator): void {
    this.#sumA = (this.#sumA + other.#sumA) >>> 0;
    this.#sumB = (this.#sumB + other.#sumB) >>> 0;
    this.#messageCount += other.#messageCount;
    this.#fragmentCount += other.#fragmentCount;
  }

  finish(): string {
    const digest = this.#sumA.toString(16).padStart(8, '0')
      + this.#sumB.toString(16).padStart(8, '0');
    return `v3:${this.#messageCount}:${this.#fragmentCount}:${digest}`;
  }

  #addValue(kind: string, value: unknown, source?: unknown): void {
    const [hashA, hashB] = hashRevisionValue(kind, value, source);
    this.#sumA = (this.#sumA + hashA) >>> 0;
    this.#sumB = (this.#sumB + hashB) >>> 0;
  }
}

export class OrderedTranscriptDigest {
  #count = 0;
  #sumA = 0;
  #sumB = 0;

  add(message: ChatMessage, seq: number): void {
    const [hashA, hashB] = hashRevisionValue('ordered-message', message, { seq });
    this.#sumA = (this.#sumA + hashA) >>> 0;
    this.#sumB = (this.#sumB + hashB) >>> 0;
    this.#count += 1;
  }

  finish(): string {
    const digest = this.#sumA.toString(16).padStart(8, '0')
      + this.#sumB.toString(16).padStart(8, '0');
    return `ordered-v1:${this.#count}:${digest}`;
  }
}

export function orderedTranscriptDigest(
  entries: Array<{ seq: number; message: ChatMessage }>,
): string {
  const digest = new OrderedTranscriptDigest();
  for (const entry of entries) digest.add(entry.message, entry.seq);
  return digest.finish();
}

export function attachCompactionRevisionSource<T extends object>(
  target: T,
  source: NativeMessageSource | null | undefined,
): T {
  if (!source) return target;
  Object.defineProperty(target, COMPACTION_REVISION_SOURCE, {
    value: source,
    enumerable: false,
    configurable: true,
  });
  return target;
}

function getCompactionRevisionSource(value: unknown): NativeMessageSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = (value as Record<PropertyKey, unknown>)[COMPACTION_REVISION_SOURCE];
  if (!source || typeof source !== 'object') return null;
  return source as NativeMessageSource;
}

function hashRevisionValue(
  kind: string,
  value: unknown,
  source?: unknown,
): [number, number] {
    const serialized = JSON.stringify(value) ?? 'undefined';
    let hashA = Bun.hash.xxHash32(serialized, 0x9e3779b9);
    let hashB = Bun.hash.murmur32v3(serialized, 0x85ebca6b);
    hashA = mixHash(hashA, Bun.hash.xxHash32(kind, 0xc2b2ae35));
    hashB = mixHash(hashB, Bun.hash.murmur32v3(kind, 0x27d4eb2d));
    if (source !== undefined) {
      const serializedSource = JSON.stringify(source);
      hashA = mixHash(hashA, Bun.hash.xxHash32(serializedSource, 0x165667b1));
      hashB = mixHash(hashB, Bun.hash.murmur32v3(serializedSource, 0x01000193));
    }
    return [hashA, hashB];
}

export function transcriptRevision(messages: ChatMessage[]): string {
  return transcriptRevisions(messages).full;
}

export function transcriptRevisions(
  messages: ChatMessage[],
  prefixLength = messages.length,
): { prefix: string; full: string } {
  const accumulator = new TranscriptRevisionAccumulator();
  let prefix = prefixLength === 0 ? accumulator.finish() : undefined;
  for (let index = 0; index < messages.length; index += 1) {
    accumulator.add(messages[index]);
    if (index + 1 === prefixLength) prefix = accumulator.finish();
  }
  return { prefix: prefix ?? accumulator.finish(), full: accumulator.finish() };
}

function compactionWithoutMetadata(message: CompactionMessage): Record<string, unknown> {
  const { trigger: _trigger, preTokens: _preTokens, postTokens: _postTokens, ...wireValue } = message;
  return wireValue;
}

function mixHash(left: number, right: number): number {
  return Math.imul(left ^ ((right << 13) | (right >>> 19)), 0x9e3779b1) >>> 0;
}
