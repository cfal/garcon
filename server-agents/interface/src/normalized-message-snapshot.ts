import type { ChatMessage } from '@garcon/common/chat-types';
import { parseOwnedNodeMessage } from './node-wire-message.js';

/** Reconstructs shared message classes on a private in-memory snapshot without wire encoding. */
export function snapshotNormalizedMessage(message: unknown): ChatMessage {
  const snapshot = parseOwnedNodeMessage(structuredClone(message));
  if (!snapshot) throw new TypeError('Invalid normalized transcript message');
  return snapshot;
}
