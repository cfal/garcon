import { promises as fs } from 'fs';
import { parseSessionEntries } from '@earendil-works/pi-coding-agent';
import { isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type {
  PiSettlementBaseline,
  PiTurnSettlementRecord,
} from './pi-rpc-session-state.js';

// Native persistence evidence for one Pi turn, keyed by session entry identity
// rather than rendered content. The baseline captures the message-entry ids
// present before the prompt, and settlement requires enough NEW message
// entries per role to cover every finalized occurrence, so a distinct
// pre-existing equal-content occurrence can never satisfy the proof and
// tool-only or tool-result messages count without rendering.
export function addExpectedNativeMessage(counts: Map<string, number>, role: string): void {
  counts.set(role, (counts.get(role) ?? 0) + 1);
}

interface PiSessionMessageOccurrence {
  readonly id: string | null;
  readonly role: string;
}

async function readMessageOccurrences(
  nativePath: string,
): Promise<readonly PiSessionMessageOccurrence[]> {
  const raw = await fs.readFile(nativePath, 'utf8');
  return parseSessionEntries(raw).flatMap((entry) => {
    if (entry.type !== 'message') return [];
    const role = (entry.message as { role?: unknown } | undefined)?.role;
    if (typeof role !== 'string') return [];
    return [{
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null,
      role,
    }];
  });
}

// Captures the message-entry identities present before the prompt. A missing
// file is a genuinely empty baseline; an unreadable or id-less baseline makes
// occurrence accounting impossible and the turn stays unresolved.
export async function snapshotPiSettlementBaseline(
  nativePath: string | null,
): Promise<PiSettlementBaseline> {
  if (!nativePath || isArtificialNativePath(nativePath)) {
    return { kind: 'ready', entryIds: new Set() };
  }
  try {
    const occurrences = await readMessageOccurrences(nativePath);
    if (occurrences.some((occurrence) => occurrence.id === null)) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'ready',
      entryIds: new Set(occurrences.map((occurrence) => occurrence.id!)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ready', entryIds: new Set() };
    }
    return { kind: 'unavailable' };
  }
}

export async function verifyPiTurnSettlement(
  record: PiTurnSettlementRecord | undefined,
): Promise<'confirmed' | 'unresolved'> {
  if (!record || record.steeringUnresolved) return 'unresolved';
  if (record.expected.size === 0) return 'confirmed';
  if (record.baseline.kind !== 'ready') return 'unresolved';
  if (!record.nativePath || isArtificialNativePath(record.nativePath)) return 'unresolved';
  let occurrences: readonly PiSessionMessageOccurrence[];
  try {
    occurrences = await readMessageOccurrences(record.nativePath);
  } catch {
    return 'unresolved';
  }
  // Entries whose id was present at the baseline are prior occurrences and
  // never count; an id-less entry cannot predate a fully-identified baseline.
  const appendedByRole = new Map<string, number>();
  for (const occurrence of occurrences) {
    if (occurrence.id !== null && record.baseline.entryIds.has(occurrence.id)) continue;
    appendedByRole.set(occurrence.role, (appendedByRole.get(occurrence.role) ?? 0) + 1);
  }
  for (const [role, expected] of record.expected) {
    if ((appendedByRole.get(role) ?? 0) < expected) return 'unresolved';
  }
  return 'confirmed';
}
