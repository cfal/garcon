import { promises as fs } from 'fs';
import { parseSessionEntries } from '@earendil-works/pi-coding-agent';
import { isArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import type {
  PiSettlementBaseline,
  PiTurnSettlementRecord,
} from './pi-rpc-session-state.js';

// Native persistence evidence for one Pi turn, keyed by session entry identity
// rather than rendered content. The baseline captures the message-entry ids
// present before the prompt, and settlement requires the ordered sequence of
// finalized occurrence roles to appear, in provider file order, among the NEW
// entries beyond that baseline. A distinct pre-existing equal-content
// occurrence can never satisfy the proof, reversed or interposed rows cannot
// stand in for a different expected sequence, and tool-only or tool-result
// messages count without rendering.
export function addExpectedNativeMessage(occurrences: string[], role: string): void {
  occurrences.push(role);
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

// Settlement proof: the verdict plus, on confirmation, the binding from each
// live occurrence identity to the proven native entry ID, in provider file
// order. The audit uses those bindings to match live-journalled rows against
// native evidence without guessing.
export interface PiTurnSettlementProof {
  readonly verdict: 'confirmed' | 'unresolved';
  readonly itemAliases?: ReadonlyMap<string, string>;
}

export async function verifyPiTurnSettlement(
  record: PiTurnSettlementRecord | undefined,
): Promise<PiTurnSettlementProof> {
  if (!record || record.steeringUnresolved) return { verdict: 'unresolved' };
  if (record.expected.length === 0) return { verdict: 'confirmed' };
  const baseline = record.baseline;
  if (baseline.kind !== 'ready') return { verdict: 'unresolved' };
  if (!record.nativePath || isArtificialNativePath(record.nativePath)) {
    return { verdict: 'unresolved' };
  }
  let occurrences: readonly PiSessionMessageOccurrence[];
  try {
    occurrences = await readMessageOccurrences(record.nativePath);
  } catch {
    return { verdict: 'unresolved' };
  }
  // Duplicate entry ids make occurrence attribution ambiguous.
  const seenIds = new Set<string>();
  for (const occurrence of occurrences) {
    if (occurrence.id === null) continue;
    if (seenIds.has(occurrence.id)) return { verdict: 'unresolved' };
    seenIds.add(occurrence.id);
  }
  // Entries whose id was present at the baseline are prior occurrences and
  // never count; an id-less entry cannot predate a fully-identified baseline.
  // The expected roles must appear as an ordered subsequence of the new
  // entries in file order, so extra provider entries are tolerated but a
  // reversed or substituted sequence is not.
  const appended = occurrences.filter((occurrence) => (
    occurrence.id === null || !baseline.entryIds.has(occurrence.id)
  ));
  const itemAliases = new Map<string, string>();
  let expectedIndex = 0;
  for (const occurrence of appended) {
    if (expectedIndex < record.expected.length
        && occurrence.role === record.expected[expectedIndex]) {
      if (record.turnId && occurrence.id !== null) {
        itemAliases.set(`turn:${record.turnId}:end:${expectedIndex}`, occurrence.id);
      }
      expectedIndex += 1;
    }
  }
  return expectedIndex === record.expected.length
    ? { verdict: 'confirmed', itemAliases }
    : { verdict: 'unresolved' };
}
