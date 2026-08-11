import { transcriptRevision } from '../../lib/transcript-revision.js';
import { serializeCompositeTranscriptRevision } from '../composite-transcript-revision.js';

export const TEST_AGENT_OWNERSHIP_EPOCH = 'test-agent-ownership-epoch';
export const EMPTY_CARRY_OVER_REVISION = 'carry-v1:0';

export function transcriptSnapshot(messages, options = {}) {
  const archivedLogicalCount = options.archivedLogicalCount ?? 0;
  const nativeMessages = options.nativeMessages ?? messages.slice(archivedLogicalCount);
  const carryOverRevision = options.carryOverRevision ?? EMPTY_CARRY_OVER_REVISION;
  const agentOwnershipEpoch = options.agentOwnershipEpoch ?? TEST_AGENT_OWNERSHIP_EPOCH;
  const nativeRevision = options.nativeRevision ?? transcriptRevision(nativeMessages);
  return {
    messages: [...messages],
    nativeMessages: [...nativeMessages],
    compositeRevision: options.compositeRevision ?? serializeCompositeTranscriptRevision({
      carryOver: carryOverRevision,
      native: nativeRevision,
      agentOwnershipEpoch,
    }),
    carryOverRevision,
    agentOwnershipEpoch,
    archivedLogicalCount,
    nativePrefixDigest: options.nativePrefixDigest ?? transcriptRevision(nativeMessages),
    projectionState: options.projectionState ?? null,
  };
}

export function nativeReconciliation(messages, options = {}) {
  const snapshot = transcriptSnapshot(messages, {
    ...options,
    nativeMessages: messages,
    archivedLogicalCount: options.archivedLogicalCount ?? 0,
  });
  return {
    messages: snapshot.nativeMessages,
    compositeRevision: snapshot.compositeRevision,
    carryOverRevision: snapshot.carryOverRevision,
    agentOwnershipEpoch: snapshot.agentOwnershipEpoch,
    archivedLogicalCount: snapshot.archivedLogicalCount,
    nativePrefixDigest: snapshot.nativePrefixDigest,
    projectionState: snapshot.projectionState,
  };
}

export function snapshotLoader(loadMessages, options = {}) {
  return async () => transcriptSnapshot(await loadMessages(), options);
}

export function transcriptLoader(loadMessages, options = {}) {
  return { loadAll: snapshotLoader(loadMessages, options) };
}

export function historyPage(messages, limit, offset, options = {}) {
  const snapshot = transcriptSnapshot(messages, options);
  const end = Math.max(0, messages.length - offset);
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    total: messages.length,
    hasMore: start > 0,
    offset,
    limit,
    compositeRevision: snapshot.compositeRevision,
    carryOverRevision: snapshot.carryOverRevision,
    agentOwnershipEpoch: snapshot.agentOwnershipEpoch,
    archivedLogicalCount: snapshot.archivedLogicalCount,
    nativePrefixDigest: options.nativePrefixDigest ?? null,
    projectionState: snapshot.projectionState,
  };
}

export function pagedTranscriptLoader(historyRef, options = {}) {
  return {
    loadAll: snapshotLoader(() => historyRef.current, options),
    loadPage: async (limit, offset) => historyPage(historyRef.current, limit, offset, options),
  };
}
