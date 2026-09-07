import type { ChatMessage } from '@garcon/common/chat-types';

export function orderedTranscriptDigest(
  entries: readonly { readonly seq: number; readonly message: ChatMessage }[],
): string {
  let sumA = 0;
  let sumB = 0;
  for (const entry of entries) {
    const serialized = JSON.stringify(entry.message) ?? 'undefined';
    let hashA = Bun.hash.xxHash32(serialized, 0x9e3779b9);
    let hashB = Bun.hash.murmur32v3(serialized, 0x85ebca6b);
    hashA = mixHash(hashA, Bun.hash.xxHash32('ordered-message', 0xc2b2ae35));
    hashB = mixHash(hashB, Bun.hash.murmur32v3('ordered-message', 0x27d4eb2d));
    const position = JSON.stringify({ seq: entry.seq });
    hashA = mixHash(hashA, Bun.hash.xxHash32(position, 0x165667b1));
    hashB = mixHash(hashB, Bun.hash.murmur32v3(position, 0x01000193));
    sumA = (sumA + hashA) >>> 0;
    sumB = (sumB + hashB) >>> 0;
  }
  const digest = sumA.toString(16).padStart(8, '0')
    + sumB.toString(16).padStart(8, '0');
  return `ordered-v1:${entries.length}:${digest}`;
}

function mixHash(left: number, right: number): number {
  return Math.imul(left ^ ((right << 13) | (right >>> 19)), 0x9e3779b1) >>> 0;
}
