import type { ChatMessage } from '../../../common/chat-types.js';

export const SEARCH_TRANSCRIPT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export function throwIfSearchLoadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Transcript search load cancelled', 'AbortError');
}

export function appendSearchBatch(
  target: ChatMessage[],
  messages: readonly ChatMessage[],
  batchSize: number,
): ChatMessage[] | null {
  target.push(...messages);
  if (target.length < batchSize) return null;
  return target.splice(0, target.length);
}
