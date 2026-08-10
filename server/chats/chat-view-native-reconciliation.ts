import crypto from 'crypto';
import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewMessage } from '../../common/chat-view.js';
import {
  OrderedTranscriptDigest,
  orderedTranscriptDigest,
  transcriptRevision,
} from '../lib/transcript-revision.js';
import {
  exactMessageIdentityKeys,
  preserveRetainedUserIdentities,
  retainedMessageMatchesNative,
} from './chat-message-reconciliation.js';

export interface NativeSnapshotReconciliation {
  readonly messages: readonly ChatMessage[];
  readonly compositeRevision: string;
  readonly carryOverRevision: string;
  readonly agentOwnershipEpoch: string;
  readonly archivedLogicalCount: number;
  readonly nativePrefixDigest: string;
}

export interface MutableChatView {
  chatId: string;
  generationId: string;
  createdAt: string;
  historyReadAt: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  historyLastSeq: number;
  complete: boolean;
  loadedFromFullHistory: boolean;
  retainedStartSeq: number;
  compositeRevision?: string;
  carryOverRevision?: string;
  agentOwnershipEpoch?: string;
  archivedLogicalCount: number;
  nativePrefixDigest: string | null;
  evictedLiveStartSeq?: number;
  evictedLiveEndSeq?: number;
  evictedLiveDigest: OrderedTranscriptDigest;
  streamFence: number;
  lastAccessAt: number;
  lastAccessOrder: number;
}

export type ChatViewGenerationReason =
  | 'native-history-load'
  | 'native-history-page'
  | 'native-history-reconciled'
  | 'native-history-mismatch'
  | 'native-replacement'
  | 'manual-reload'
  | 'process-error'
  | 'initial-live-append'
  | 'initial-provisional-append';

export interface ChatViewGenerationTransition {
  reason: ChatViewGenerationReason;
  previousGenerationId?: string;
  generationId?: string;
  persistence?: Pick<
    NativeSnapshotReconciliation,
    | 'agentOwnershipEpoch'
    | 'archivedLogicalCount'
    | 'carryOverRevision'
    | 'compositeRevision'
    | 'nativePrefixDigest'
  >;
}

interface ReconcileNativeViewInput {
  readonly chatId: string;
  readonly snapshot: NativeSnapshotReconciliation;
  readonly previous?: MutableChatView;
  readonly messageLimit: number;
  readonly now: number;
  readonly streamFence: number;
  readonly lastAccessOrder: number;
}

export interface ReconciledNativeView {
  readonly view: MutableChatView;
  readonly transition: ChatViewGenerationTransition;
  readonly unpersistedLiveMessages: ChatMessage[];
}

export function reconcileNativeSnapshotView(
  input: ReconcileNativeViewInput,
): ReconciledNativeView {
  const { chatId, snapshot, previous } = input;
  const retainedNativeEntries = previous?.messages.filter(
    (entry) => entry.seq > snapshot.archivedLogicalCount,
  ) ?? [];
  const nativeMessages = previous
    ? preserveRetainedUserIdentities(retainedNativeEntries, [...snapshot.messages])
    : [...snapshot.messages];
  const persistedTotal = snapshot.archivedLogicalCount + nativeMessages.length;
  const retainedLiveEntries = previous?.messages.filter(
    (entry) => entry.seq > previous.historyLastSeq,
  ) ?? [];
  const priorNativePrefixMatches = previous
    ? nativePrefixMatchesView(previous, snapshot, nativeMessages)
    : false;
  const retainedLiveStartSeq = previous
    ? Math.max(previous.historyLastSeq + 1, previous.retainedStartSeq)
    : snapshot.archivedLogicalCount + 1;
  const retainedLiveIsContiguous = previous
    ? retainedLiveEntries.every(
      (entry, index) => entry.seq === retainedLiveStartSeq + index,
    )
    : false;
  const nativeGrowthClosesTrimmedGap = previous
    ? persistedTotal >= Math.min(retainedLiveStartSeq - 1, previous.lastSeq)
    : false;
  const evictedLiveRangeClosed = previous?.evictedLiveEndSeq === undefined
    || persistedTotal >= previous.evictedLiveEndSeq;
  const evictedLiveMatches = previous?.evictedLiveStartSeq === undefined
    || previous.evictedLiveEndSeq === undefined
    || evictedLiveRangeClosed && orderedTranscriptDigest(
      nativeMessages
        .slice(
          previous.evictedLiveStartSeq - snapshot.archivedLogicalCount - 1,
          previous.evictedLiveEndSeq - snapshot.archivedLogicalCount,
        )
        .map((message, index) => ({
          seq: previous.evictedLiveStartSeq! + index,
          message,
        })),
    ) === previous.evictedLiveDigest.finish();
  const retainedNativeOverlapMatches = previous
    ? retainedLiveEntries
      .filter((entry) => entry.seq <= persistedTotal)
      .every((entry) => retainedMessageMatchesNative(
        entry.message,
        nativeMessages[entry.seq - snapshot.archivedLogicalCount - 1],
      ))
    : false;
  const preservesGeneration = Boolean(
    previous
    && priorNativePrefixMatches
    && retainedLiveIsContiguous
    && nativeGrowthClosesTrimmedGap
    && evictedLiveRangeClosed
    && evictedLiveMatches
    && retainedNativeOverlapMatches,
  );
  const transition: ChatViewGenerationTransition = {
    reason: !previous
      ? 'native-history-load'
      : preservesGeneration
        ? 'native-history-reconciled'
        : 'native-history-mismatch',
    previousGenerationId: previous?.generationId,
    generationId: preservesGeneration ? previous?.generationId : undefined,
    persistence: snapshot,
  };
  const view = createNativeOnlyGeneration({
    ...input,
    nativeMessages,
    transition,
    previous: preservesGeneration ? previous : undefined,
  });
  const nativeIdentities = new Set(nativeMessages.flatMap(exactMessageIdentityKeys));
  const unpersistedLiveMessages = previous
    ? retainedLiveEntries
      .filter((entry) => {
        const identities = exactMessageIdentityKeys(entry.message);
        return entry.seq > persistedTotal
          && !identities.some((identity) => nativeIdentities.has(identity));
      })
      .map((entry) => entry.message)
    : [];
  return { view, transition, unpersistedLiveMessages };
}

export function persistenceMatches(
  view: MutableChatView,
  input: Pick<
    NativeSnapshotReconciliation,
    'agentOwnershipEpoch' | 'archivedLogicalCount' | 'carryOverRevision'
  >,
): boolean {
  return view.carryOverRevision === input.carryOverRevision
    && view.agentOwnershipEpoch === input.agentOwnershipEpoch
    && view.archivedLogicalCount === input.archivedLogicalCount;
}

export function nativePrefixMatchesView(
  view: MutableChatView,
  snapshot: NativeSnapshotReconciliation,
  nativeMessages: readonly ChatMessage[],
): boolean {
  if (!persistenceMatches(view, snapshot)) return false;
  const previousNativeCount = Math.max(
    0,
    view.historyLastSeq - snapshot.archivedLogicalCount,
  );
  if (nativeMessages.length < previousNativeCount) return false;
  const retainedNativeOverlapMatches = view.messages
    .filter((entry) => (
      entry.seq > snapshot.archivedLogicalCount
      && entry.seq <= view.historyLastSeq
    ))
    .every((entry) => retainedMessageMatchesNative(
      entry.message,
      nativeMessages[entry.seq - snapshot.archivedLogicalCount - 1],
    ));
  if (!retainedNativeOverlapMatches) return false;
  if (view.nativePrefixDigest !== null) {
    return transcriptRevision(nativeMessages.slice(0, previousNativeCount))
      === view.nativePrefixDigest;
  }
  // Canonical page and snapshot revisions identify the same complete transcript,
  // which bootstraps page-backed views without treating native growth as safe.
  return view.compositeRevision === snapshot.compositeRevision;
}

function createNativeOnlyGeneration(input: ReconcileNativeViewInput & {
  readonly nativeMessages: ChatMessage[];
  readonly transition: ChatViewGenerationTransition;
}): MutableChatView {
  const historyLastSeq = input.snapshot.archivedLogicalCount + input.nativeMessages.length;
  const nativeEntries = input.nativeMessages.map((message, index) => ({
    seq: input.snapshot.archivedLogicalCount + index + 1,
    message,
  }));
  const archivedEntries = input.previous?.messages.filter(
    (entry) => entry.seq <= input.snapshot.archivedLogicalCount,
  ) ?? [];
  const messages = [...archivedEntries, ...nativeEntries].slice(-input.messageLimit);
  const complete = historyLastSeq === 0 || (
    messages.length === historyLastSeq
    && messages[0]?.seq === 1
    && messages.every((entry, index) => entry.seq === index + 1)
  );
  const isoNow = new Date(input.now).toISOString();
  return {
    chatId: input.chatId,
    generationId: input.transition.generationId ?? crypto.randomUUID(),
    createdAt: isoNow,
    historyReadAt: isoNow,
    messages,
    lastSeq: historyLastSeq,
    historyLastSeq,
    complete,
    loadedFromFullHistory: complete,
    retainedStartSeq: messages[0]?.seq ?? historyLastSeq + 1,
    compositeRevision: input.snapshot.compositeRevision,
    carryOverRevision: input.snapshot.carryOverRevision,
    agentOwnershipEpoch: input.snapshot.agentOwnershipEpoch,
    archivedLogicalCount: input.snapshot.archivedLogicalCount,
    nativePrefixDigest: input.snapshot.nativePrefixDigest,
    evictedLiveDigest: new OrderedTranscriptDigest(),
    streamFence: input.streamFence,
    lastAccessAt: input.now,
    lastAccessOrder: input.lastAccessOrder,
  };
}
