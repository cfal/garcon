import { isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { loadPiChatMessages } from './history-loader.js';
import type { PiTurnSettlementRecord } from './pi-rpc-session-state.js';

// Native persistence evidence for one Pi turn. A turn's finalized rows are
// counted by rendered identity, and settlement verifies the session file grew
// by exactly that evidence beyond the pre-prompt baseline.
export function addExpectedNativeRow(
  counts: Map<string, number>,
  type: 'user-message' | 'assistant-message',
  content: string,
): void {
  const key = `${type}\u0000${content}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export async function countPiNativeRows(
  nativePath: string | null,
): Promise<ReadonlyMap<string, number>> {
  if (!nativePath || isArtificialNativePath(nativePath)) return new Map();
  try {
    const counts = new Map<string, number>();
    for (const message of await loadPiChatMessages(nativePath)) {
      if ((message.type === 'user-message' || message.type === 'assistant-message')
          && typeof message.content === 'string' && message.content.length > 0) {
        addExpectedNativeRow(counts, message.type, message.content);
      }
    }
    return counts;
  } catch {
    return new Map();
  }
}

export async function verifyPiTurnSettlement(
  record: PiTurnSettlementRecord | undefined,
): Promise<'confirmed' | 'unresolved'> {
  if (!record || record.steeringUnresolved) return 'unresolved';
  if (record.expected.size === 0) return 'confirmed';
  if (!record.nativePath || isArtificialNativePath(record.nativePath)) return 'unresolved';
  const current = await countPiNativeRows(record.nativePath);
  for (const [key, expected] of record.expected) {
    if ((current.get(key) ?? 0) - (record.baseline.get(key) ?? 0) < expected) {
      return 'unresolved';
    }
  }
  return 'confirmed';
}
