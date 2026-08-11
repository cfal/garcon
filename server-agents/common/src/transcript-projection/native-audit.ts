import type {
  AgentTranscriptEntry,
  AgentTranscriptSourceIdentity,
} from '@garcon/server-agent-interface';
import { sourceIdentityKey } from './identity.js';
import type { AgentTranscriptSeedEntry } from './journal-stream.js';

// Compares an existing projection journal against current provider-native
// evidence by canonical source identity. The journal stays the rendering
// authority in every outcome: the audit may import a crash-missed native
// suffix once, advance the native-retention floor when a clean native prefix
// loss explains provider compaction, report the projection running ahead of a
// provider that has not persisted the committed tail yet, or report divergence
// that fences native fork continuity. It never re-renders or removes committed
// rows, and message content never participates.
export type NativeAuditOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'diverged' }
  | {
      readonly kind: 'aligned';
      readonly suffix: readonly AgentTranscriptSeedEntry[];
      readonly nativeRetentionFloor: number | null;
      // Ordinal of the first committed entry the provider has not persisted;
      // recomputed on every audit rather than recorded, so it clears itself
      // once the provider catches up.
      readonly aheadFromOrdinal: number | null;
      // Native aliases observed for already-committed identities, so rows
      // journalled from live events gain their provider positions once the
      // provider persists them.
      readonly matchedAliases: ReadonlyMap<string, AgentTranscriptSeedEntry>;
    };

export function auditNativeEvidence(options: {
  readonly ownerId: string;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly seeds: readonly AgentTranscriptSeedEntry[];
}): NativeAuditOutcome {
  const namespace = `${options.ownerId}:native`;
  // Rows without a canonical native identity anchor by order rather than
  // source key, never by content: an admission row claims the next native
  // user occurrence, and a row journalled from a live event under a
  // process-local identity claims the next native occurrence of its exact
  // message type. Claiming instead of importing is what keeps a stream-
  // rendered row from being duplicated by the audit, and the bound alias is
  // what makes it line-cut forkable.
  const journal = options.entries.flatMap(
    (entry, index): {
      ordinal: number;
      key: string;
      kind: 'exact' | 'admission' | 'stream';
      messageType: string;
    }[] => {
      const source = entry.source;
      if (entry.lifetime !== 'durable' || source === null) return [];
      const messageType = entry.message.type;
      if (comparableSource(source, namespace)) {
        return [{ ordinal: index + 1, key: sourceIdentityKey(source), kind: 'exact', messageType }];
      }
      if (source.namespace === 'garcon:admission' && messageType === 'user-message') {
        return [{ ordinal: index + 1, key: sourceIdentityKey(source), kind: 'admission', messageType }];
      }
      if (source.namespace === namespace && source.itemId.startsWith('event:')) {
        return [{ ordinal: index + 1, key: sourceIdentityKey(source), kind: 'stream', messageType }];
      }
      return [];
    },
  );
  // A populated journal without any anchor offers nothing to match against,
  // and importing anything could duplicate rows imported at genesis under
  // process-local fallback identities.
  if (journal.length === 0 && options.entries.length > 0) return { kind: 'skipped' };

  const native: { readonly key: string; readonly seed: AgentTranscriptSeedEntry }[] = [];
  const nativePositions = new Map<string, number>();
  for (const seed of options.seeds) {
    if (!comparableSource(seed.source, namespace)) continue;
    const key = sourceIdentityKey(seed.source);
    // Duplicate native identities make the evidence ambiguous; retry later.
    if (nativePositions.has(key)) return { kind: 'skipped' };
    nativePositions.set(key, native.length);
    native.push({ key, seed });
  }
  // Empty evidence cannot distinguish provider pruning from an unreadable
  // source, and the retention floor is monotonic; leave it for a later audit.
  if (native.length === 0 && journal.length > 0) return { kind: 'skipped' };

  let lastMatchedNativePosition = -1;
  const missing: number[] = [];
  const matchedAliases = new Map<string, AgentTranscriptSeedEntry>();
  const claimed = new Set<number>();
  let firstMatchedJournalIndex = -1;
  let lastMatchedJournalIndex = -1;
  for (const [index, committed] of journal.entries()) {
    let position: number | undefined;
    if (committed.kind === 'exact') {
      position = nativePositions.get(committed.key);
      // Native order must preserve committed order.
      if (position !== undefined && position <= lastMatchedNativePosition) {
        return { kind: 'diverged' };
      }
    } else {
      const claimableType = committed.kind === 'admission' ? 'user-message' : committed.messageType;
      for (let candidate = lastMatchedNativePosition + 1; candidate < native.length; candidate += 1) {
        if (claimed.has(candidate)) continue;
        if (native[candidate]!.seed.message.type !== claimableType) continue;
        position = candidate;
        break;
      }
    }
    if (position === undefined) {
      missing.push(index);
      continue;
    }
    if (firstMatchedJournalIndex === -1) firstMatchedJournalIndex = index;
    lastMatchedJournalIndex = index;
    lastMatchedNativePosition = position;
    claimed.add(position);
    matchedAliases.set(committed.key, native[position]!.seed);
  }
  // Missing identities are explainable only at the edges: a missing prefix is
  // provider compaction and a missing tail is a provider that has not
  // persisted the committed suffix yet. A hole between matched identities is
  // neither.
  const missingPrefix = missing.filter((index) => (
    firstMatchedJournalIndex === -1 || index < firstMatchedJournalIndex
  ));
  const missingTail = missing.filter((index) => (
    firstMatchedJournalIndex !== -1 && index > lastMatchedJournalIndex
  ));
  if (missingPrefix.length + missingTail.length !== missing.length) return { kind: 'diverged' };
  // Native rows the journal missed may only trail the last matched identity;
  // importing anything earlier would reorder committed ordinals.
  const journalKeys = new Set(journal.flatMap((committed) => (
    committed.kind === 'exact' ? [committed.key] : []
  )));
  for (const [position, row] of native.entries()) {
    if (position > lastMatchedNativePosition) break;
    if (!claimed.has(position) && !journalKeys.has(row.key)) return { kind: 'diverged' };
  }
  const suffix = native
    .slice(lastMatchedNativePosition + 1)
    .filter((row) => !journalKeys.has(row.key))
    .map((row) => row.seed);
  // A provider that moved on to new rows without persisting the committed
  // tail is not merely behind.
  if (missingTail.length > 0 && suffix.length > 0) return { kind: 'diverged' };

  return {
    kind: 'aligned',
    suffix,
    nativeRetentionFloor: missingPrefix.length === 0
      ? null
      : journal[missingPrefix.at(-1)!]!.ordinal,
    aheadFromOrdinal: missingTail.length === 0
      ? null
      : journal[missingTail[0]!]!.ordinal,
    matchedAliases,
  };
}

function comparableSource(
  source: AgentTranscriptSourceIdentity | null,
  namespace: string,
): boolean {
  return source !== null
    && source.namespace === namespace
    && !source.itemId.startsWith('event:');
}
