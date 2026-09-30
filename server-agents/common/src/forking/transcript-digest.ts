import type { ChatMessage } from '@garcon/common/chat-types';

// Accumulates an order-sensitive digest one message at a time, so a long
// transcript can be digested in time-bounded steps. Each message is digested
// with its 1-based position.
export class OrderedTranscriptDigest {
  #sumA = 0;
  #sumB = 0;
  #count = 0;

  add(message: ChatMessage): void {
    this.#count += 1;
    const serialized = JSON.stringify(message) ?? 'undefined';
    let hashA = Bun.hash.xxHash32(serialized, 0x9e3779b9);
    let hashB = Bun.hash.murmur32v3(serialized, 0x85ebca6b);
    hashA = mixHash(hashA, Bun.hash.xxHash32('ordered-message', 0xc2b2ae35));
    hashB = mixHash(hashB, Bun.hash.murmur32v3('ordered-message', 0x27d4eb2d));
    const position = JSON.stringify({ seq: this.#count });
    hashA = mixHash(hashA, Bun.hash.xxHash32(position, 0x165667b1));
    hashB = mixHash(hashB, Bun.hash.murmur32v3(position, 0x01000193));
    this.#sumA = (this.#sumA + hashA) >>> 0;
    this.#sumB = (this.#sumB + hashB) >>> 0;
  }

  digest(): string {
    const digest = this.#sumA.toString(16).padStart(8, '0')
      + this.#sumB.toString(16).padStart(8, '0');
    return `ordered-v1:${this.#count}:${digest}`;
  }
}

function mixHash(left: number, right: number): number {
  return Math.imul(left ^ ((right << 13) | (right >>> 19)), 0x9e3779b1) >>> 0;
}
