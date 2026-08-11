import crypto from 'node:crypto';
import type {
  AgentTranscriptCommitEvent,
  AgentTranscriptEntry,
  AgentTranscriptProvenance,
} from '@garcon/server-agent-interface';
import type { ChatMessage } from '../common/chat-types.js';
import type { ChatViewMessage } from '../common/chat-view.js';
import {
  ChatMessagesMessage,
  ChatProjectionGenerationTransitionMessage,
  ChatTransientFeedMutationMessage,
} from '../common/ws-events.ts';
import type { AppliedProjectionEvent } from './agents/projection-ingress.js';
import type { ChatTransientFeedStore } from './chats/chat-transient-feed.js';
import type { ChatMetadataIdentity } from './chats/metadata-store.js';
import type {
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  ChatViewStore,
} from './chats/chat-view-store.js';
import type { AgentProjectionState } from '@garcon/server-agent-interface';

export interface ProjectionEventFanoutDeps {
  chatExists(chatId: string): boolean;
  scheduleChatTask(chatId: string, label: string, task: () => Promise<void> | void): Promise<void>;
  broadcast(payload: unknown): void;
  chatRegistry: {
    getChat(chatId: string): {
      agentOwnershipEpoch: string;
      transcriptContentEpoch?: string | null;
    } | null;
    updateChat(
      chatId: string,
      patch: { transcriptContentEpoch: string },
      options: { flush: boolean },
    ): Promise<unknown>;
  };
  chatViews: Pick<
    ChatViewStore,
    'getCursor' | 'getOrCreatePage' | 'replaceFromProjection' | 'applyProjectionCommit'
  >;
  transientFeeds: Pick<ChatTransientFeedStore, 'apply' | 'currentSnapshot' | 'rebaseGeneration'>;
  metadata: {
    updateFromAppendedMessages(
      chatId: string,
      messages: ChatMessage[],
      identity?: ChatMetadataIdentity,
    ): void;
    rebuildFromProjectionReset(
      chatId: string,
      messages: readonly ChatMessage[],
      identity: ChatMetadataIdentity,
    ): void;
  };
  getCarryOverRevision(chatId: string): string;
  commandLedger: {
    appendProjectionAssistantMessages(
      chatId: string,
      owner: NonNullable<AgentTranscriptProvenance['turnOwner']>,
      contents: readonly string[],
    ): Promise<unknown>;
  };
  pendingInputs: { reconcileRetainedHistory(chatId: string): Promise<void> };
  markSearchChatDirty(chatId: string): void;
  markSearchCatalogDirty(chatId: string): void;
  getCarryOverMessageCount(chatId: string): Promise<number>;
  composeProjectionSnapshot(
    chatId: string,
    messages: readonly ChatMessage[],
    revision: string,
    projectionState: AgentProjectionState,
  ): Promise<ChatTranscriptSnapshot>;
  loadChatSnapshot(chatId: string): Promise<ChatTranscriptSnapshot>;
  loadChatPage(chatId: string, limit: number, offset: number): Promise<ChatHistoryPage | null>;
}

// Folds applied integration stream events into browser state: exact commit
// application with row broadcasts, compound reset transitions, and ordered
// transient control mutations. Session events publish through the lifecycle
// path and terminals reach this fold only for control clearing.
export function createProjectionEventFanout(deps: ProjectionEventFanoutDeps) {
  return (applied: AppliedProjectionEvent): Promise<void> | void => {
    const event = applied.event;
    if (event.kind === 'session' || !deps.chatExists(event.chatId)) {
      return;
    }
    if (event.kind === 'commit') {
      return deps.scheduleChatTask(event.chatId, 'chat-view: projection commit failed', async () => {
        if (!deps.chatExists(event.chatId)) return;
        await applyCommit(deps, applied, event);
      });
    }
    return deps.scheduleChatTask(event.chatId, 'transient-feed: projection failed', async () => {
      if (!deps.chatExists(event.chatId)) return;
      await applyTransient(deps, applied);
    });
  };
}

// Applies one exact commit event to the browser view and its ledger-derived
// consumers. Metadata, search, and receipts are driven by the serialized event
// exactly once, independent of the view application outcome.
async function applyCommit(
  deps: ProjectionEventFanoutDeps,
  applied: AppliedProjectionEvent,
  event: AgentTranscriptCommitEvent,
): Promise<void> {
  const chatId = event.chatId;
  const appendedMessages = event.appended.map((entry) => entry.message);
  if (appendedMessages.length > 0) {
    deps.metadata.updateFromAppendedMessages(chatId, appendedMessages, {
      carryOverRevision: deps.getCarryOverRevision(chatId),
      agentOwnershipEpoch: event.agentOwnershipEpoch,
      contentEpoch: event.checkpoint.projection.contentEpoch,
      durableRevision: event.checkpoint.projection.durableRevision,
    });
  }
  if (event.promoted.length > 0
      || event.appended.some((entry) => entry.lifetime === 'durable')) {
    deps.markSearchChatDirty(chatId);
  }
  for (const group of groupEntriesByProvenance(event.appended)) {
    const owner = group.provenance?.turnOwner;
    if (!owner) continue;
    const assistantContents = group.entries.flatMap(({ message }) => (
      message.type === 'assistant-message' && message.content.length > 0
        ? [message.content]
        : []
    ));
    if (assistantContents.length > 0) {
      await deps.commandLedger.appendProjectionAssistantMessages(chatId, owner, assistantContents);
    }
  }
  const carryOverMessageCount = await deps.getCarryOverMessageCount(chatId);
  const application = await deps.chatViews.applyProjectionCommit(chatId, {
    previousProjection: event.previous.projection,
    checkpointProjection: event.checkpoint.projection,
    appendedMessages,
    carryOverMessageCount,
  }, {
    // A relist must land on the staged post-commit materialization. Reading
    // back through the registry here would observe the ingress predecessor
    // state and silently drop the very commit being applied.
    loadAll: () => deps.composeProjectionSnapshot(
      chatId,
      applied.current.entries.map((entry) => entry.message),
      event.checkpoint.projection.stateRevision,
      event.checkpoint.projection,
    ),
  });
  if (application.kind === 'applied' && application.messages.length > 0) {
    broadcastCommitRows(deps, event, application.generationId, application.messages);
  } else if (application.kind === 'relisted') {
    const previousGenerationId = deps.transientFeeds.currentSnapshot(chatId)?.generationId
      ?? application.previousGenerationId
      ?? crypto.randomUUID();
    const transition = deps.transientFeeds.rebaseGeneration({
      chatId,
      agentOwnershipEpoch: event.agentOwnershipEpoch,
      previousGenerationId,
      generationId: application.generationId,
    });
    deps.broadcast(new ChatProjectionGenerationTransitionMessage(
      transition.resetTransactionId,
      transition.serverInstanceId,
      transition.chatId,
      transition.agentOwnershipEpoch,
      transition.previousGenerationId,
      transition.generationId,
      transition.transientRevision,
      transition.stateDigest,
      transition.rows,
    ));
    // The relisted generation already contains this commit's rows, so their
    // browser seqs are fixed by the commit predecessor. Broadcasting them keeps
    // admission step order, observers, and background caches fed even when no
    // view was loaded; a client holding the relisted snapshot drops them as
    // already-applied by seq.
    if (appendedMessages.length > 0) {
      const baseSeq = carryOverMessageCount + event.previous.projection.total;
      broadcastCommitRows(
        deps,
        event,
        application.generationId,
        appendedMessages.map((message, index) => ({ seq: baseSeq + index + 1, message })),
      );
    }
  }
  await deps.pendingInputs.reconcileRetainedHistory(chatId);
}

function broadcastCommitRows(
  deps: ProjectionEventFanoutDeps,
  event: AgentTranscriptCommitEvent,
  generationId: string,
  rows: readonly ChatViewMessage[],
): void {
  let offset = 0;
  for (const group of groupEntriesByProvenance(event.appended)) {
    const groupRows = rows.slice(offset, offset + group.entries.length);
    offset += group.entries.length;
    const provenance = group.provenance;
    deps.broadcast(new ChatMessagesMessage(
      event.chatId,
      generationId,
      groupRows,
      provenance?.turnOwner.turnId ?? provenance?.turnId,
      provenance?.turnOwner.clientRequestId ?? provenance?.clientRequestId ?? undefined,
      provenance?.upstreamRequestId ?? undefined,
    ));
  }
}

async function applyTransient(
  deps: ProjectionEventFanoutDeps,
  applied: AppliedProjectionEvent,
): Promise<void> {
  const event = applied.event;
  if (event.kind === 'commit' || event.kind === 'session') return;
  const chatId = event.chatId;
  let cursor = deps.chatViews.getCursor(chatId);
  if (!cursor) {
    await deps.chatViews.getOrCreatePage(
      chatId,
      {
        loadAll: () => deps.loadChatSnapshot(chatId),
        loadPage: (limit, offset) => deps.loadChatPage(chatId, limit, offset),
      },
      1,
    );
    cursor = deps.chatViews.getCursor(chatId);
  }
  if (!cursor) throw new Error('TRANSIENT_FEED_GENERATION_UNAVAILABLE');

  const carryOverMessageCount = await deps.getCarryOverMessageCount(chatId);
  if (event.kind === 'reset') {
    const registered = deps.chatRegistry.getChat(chatId);
    if (!registered || registered.agentOwnershipEpoch !== event.agentOwnershipEpoch) {
      throw new Error('PROJECTION_RESET_STALE_OWNER');
    }
    if (registered.transcriptContentEpoch !== event.checkpoint.projection.contentEpoch) {
      await deps.chatRegistry.updateChat(
        chatId,
        { transcriptContentEpoch: event.checkpoint.projection.contentEpoch },
        { flush: true },
      );
    }
    const snapshot = await deps.composeProjectionSnapshot(
      chatId,
      applied.current.entries.map((entry) => entry.message),
      event.checkpoint.projection.stateRevision,
      event.checkpoint.projection,
    );
    // A destructive reset invalidates the preview cache: preview text is
    // recomputed from the surviving composite rows under the new identity.
    deps.metadata.rebuildFromProjectionReset(chatId, snapshot.messages, {
      carryOverRevision: snapshot.carryOverRevision,
      agentOwnershipEpoch: event.agentOwnershipEpoch,
      contentEpoch: event.checkpoint.projection.contentEpoch,
      durableRevision: event.checkpoint.projection.durableRevision,
    });
    const page = await deps.chatViews.replaceFromProjection(chatId, snapshot);
    const projected = deps.transientFeeds.apply(applied, {
      previousGenerationId: cursor.generationId,
      generationId: page.generationId,
      carryOverMessageCount,
    });
    if (projected.kind !== 'generation-transition') {
      throw new TypeError('Projection reset did not produce a compound transition');
    }
    const value = projected.value;
    deps.broadcast(new ChatProjectionGenerationTransitionMessage(
      value.resetTransactionId,
      value.serverInstanceId,
      value.chatId,
      value.agentOwnershipEpoch,
      value.previousGenerationId,
      value.generationId,
      value.transientRevision,
      value.stateDigest,
      value.rows,
    ));
    deps.markSearchCatalogDirty(chatId);
    return;
  }

  const projected = deps.transientFeeds.apply(applied, {
    generationId: cursor.generationId,
    carryOverMessageCount,
  });
  if (projected.kind === 'generation-transition') {
    const value = projected.value;
    deps.broadcast(new ChatProjectionGenerationTransitionMessage(
      value.resetTransactionId,
      value.serverInstanceId,
      value.chatId,
      value.agentOwnershipEpoch,
      value.previousGenerationId,
      value.generationId,
      value.transientRevision,
      value.stateDigest,
      value.rows,
    ));
    return;
  }
  if (projected.kind !== 'mutation') return;
  const value = projected.value;
  deps.broadcast(new ChatTransientFeedMutationMessage(
    value.serverInstanceId,
    value.chatId,
    value.agentOwnershipEpoch,
    value.generationId,
    value.transientRevision,
    value.stateDigest,
    value.mutation,
  ));
}

interface ProvenanceEntryGroup {
  readonly provenance: AgentTranscriptProvenance | null;
  readonly entries: AgentTranscriptEntry[];
}

// Groups contiguous commit entries that share one causal turn identity so each
// broadcast batch carries the provenance its rows were produced under.
function groupEntriesByProvenance(
  entries: readonly AgentTranscriptEntry[],
): ProvenanceEntryGroup[] {
  const groups: ProvenanceEntryGroup[] = [];
  for (const entry of entries) {
    const current = groups.at(-1);
    if (current && sameEntryProvenance(current.provenance, entry.provenance)) {
      current.entries.push(entry);
      continue;
    }
    groups.push({ provenance: entry.provenance, entries: [entry] });
  }
  return groups;
}

function sameEntryProvenance(
  left: AgentTranscriptProvenance | null,
  right: AgentTranscriptProvenance | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.turnId === right.turnId
    && left.clientRequestId === right.clientRequestId
    && left.commandType === right.commandType
    && left.upstreamRequestId === right.upstreamRequestId
    && left.turnOwner.turnId === right.turnOwner.turnId
    && left.turnOwner.clientRequestId === right.turnOwner.clientRequestId;
}
