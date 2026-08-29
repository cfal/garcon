import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import type { QueueEntryPlacement } from '../../common/chat-command-contracts.ts';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  MAX_CONTROL_INPUT_ENTRIES,
  MAX_STORED_APPLIED_QUEUE_COMMANDS,
  cloneStoredChatExecutionControl,
  hasPendingTurnInput,
  type StoredControlInputEntry,
  type StoredAppliedQueueCommand,
  type StoredChatExecutionControlState,
  type StoredQueueSubmissionIdentity,
  type StoredQueueEntry,
} from './control-state.ts';

export interface TransitionContext {
  now: string;
  newId(): string;
  unsettledQueueReceiptKeys(): ReadonlySet<string>;
}

export interface QueueCommandIdentity {
  key: string;
  entryId: string;
}

export type TransitionRejection =
  | { code: 'IDEMPOTENCY_CONFLICT'; clientMessageId: string }
  | { code: 'QUEUE_ENTRY_NOT_FOUND'; entryId: string }
  | { code: 'QUEUE_ENTRY_ALREADY_SENT'; entryId: string }
  | { code: 'QUEUE_ENTRY_IN_FLIGHT'; entryId: string }
  | { code: 'QUEUE_ENTRY_REVISION_CONFLICT'; entryId: string; actualRevision: number }
  | { code: 'QUEUE_ENTRY_REORDER_CONFLICT' }
  | { code: 'QUEUE_PAUSE_CHANGED' }
  | { code: 'CONTROL_INPUT_QUEUE_FULL' };

export type TransitionOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'rejected'; rejection: TransitionRejection };

export interface ControlTransition<T> {
  next: StoredChatExecutionControlState;
  outcome: TransitionOutcome<T>;
  changed: boolean;
  publicChanged: boolean;
}

export interface QueueMutationValue {
  entryId: string;
  entry: QueueEntry | null;
  duplicate: boolean;
}

export interface QueueMoveMutationValue extends QueueMutationValue {
  rebased: boolean | null;
}

export type DequeuedTurnInput =
  | { readonly kind: 'control'; readonly entry: StoredControlInputEntry }
  | { readonly kind: 'user'; readonly entry: StoredQueueEntry };

export interface ReservedQueueSteer {
  entry: StoredQueueEntry;
}

function isPendingQueueEntry(entry: StoredQueueEntry): boolean {
  return entry.status === 'queued' || entry.status === 'steering';
}

function accepted<T>(
  next: StoredChatExecutionControlState,
  value: T,
  changed: boolean,
): ControlTransition<T> {
  return { next, outcome: { status: 'ok', value }, changed, publicChanged: changed };
}

function acceptedInternal<T>(
  next: StoredChatExecutionControlState,
  value: T,
): ControlTransition<T> {
  return { next, outcome: { status: 'ok', value }, changed: true, publicChanged: false };
}

function rejected<T>(
  current: StoredChatExecutionControlState,
  rejection: TransitionRejection,
): ControlTransition<T> {
  return {
    next: cloneStoredChatExecutionControl(current),
    outcome: { status: 'rejected', rejection },
    changed: false,
    publicChanged: false,
  };
}

function bump(control: StoredChatExecutionControlState, now: string): void {
  control.version += 1;
  control.updatedAt = now;
}

function toQueueEntry(entry: StoredQueueEntry): QueueEntry {
  const { status: _status, submission: _submission, ...clientEntry } = entry;
  return { ...clientEntry };
}

function findAppliedCommand(
  control: StoredChatExecutionControlState,
  command: QueueCommandIdentity,
): StoredAppliedQueueCommand | null {
  return control.appliedCommands.find((candidate) => candidate.key === command.key) ?? null;
}

function recordAppliedCommand(
  control: StoredChatExecutionControlState,
  command: QueueCommandIdentity,
  operation: StoredAppliedQueueCommand['operation'],
  context: TransitionContext,
): void {
  const protectedKeys = new Set(context.unsettledQueueReceiptKeys());
  protectedKeys.add(command.key);
  const candidates = [
    ...control.appliedCommands.filter((candidate) => candidate.key !== command.key),
    {
      key: command.key,
      operation,
      entryId: command.entryId,
      appliedAt: context.now,
    },
  ];
  const protectedReceipts = candidates.filter((candidate) => protectedKeys.has(candidate.key));
  const terminalReceiptLimit = Math.max(
    0,
    MAX_STORED_APPLIED_QUEUE_COMMANDS - protectedReceipts.length,
  );
  const terminalCandidates = candidates.filter((candidate) => !protectedKeys.has(candidate.key));
  const terminalReceipts = terminalReceiptLimit === 0
    ? []
    : terminalCandidates.slice(-terminalReceiptLimit);
  const retainedKeys = new Set([
    ...protectedReceipts.map((candidate) => candidate.key),
    ...terminalReceipts.map((candidate) => candidate.key),
  ]);
  control.appliedCommands = candidates.filter((candidate) => retainedKeys.has(candidate.key));
}

function missingEntryRejection(
  control: StoredChatExecutionControlState,
  entryId: string,
): TransitionRejection {
  return control.recentlyDispatched.some((entry) => entry.entryId === entryId)
    ? { code: 'QUEUE_ENTRY_ALREADY_SENT', entryId }
    : { code: 'QUEUE_ENTRY_NOT_FOUND', entryId };
}

export function createQueueEntry(
  current: StoredChatExecutionControlState,
  input: {
    content: string;
    command?: QueueCommandIdentity;
    submission?: StoredQueueSubmissionIdentity;
  },
  context: TransitionContext,
): ControlTransition<QueueMutationValue> {
  const next = cloneStoredChatExecutionControl(current);
  if (input.submission) {
    const submitted = next.entries.find((entry) => (
      entry.submission?.clientMessageId === input.submission!.clientMessageId
      && entry.submission.transcriptViewId === input.submission!.transcriptViewId
    ));
    if (submitted) {
      if (submitted.content !== input.content) {
        return rejected(current, {
          code: 'IDEMPOTENCY_CONFLICT',
          clientMessageId: input.submission.clientMessageId,
        });
      }
      return accepted(next, {
        entryId: submitted.id,
        entry: toQueueEntry(submitted),
        duplicate: true,
      }, false);
    }
  }
  if (input.command) {
    const applied = findAppliedCommand(next, input.command);
    if (applied) {
      const entry = next.entries.find((candidate) => candidate.id === applied.entryId);
      return accepted(next, {
        entryId: applied.entryId,
        entry: entry ? toQueueEntry(entry) : null,
        duplicate: true,
      }, false);
    }
  }

  const entry: StoredQueueEntry = {
    id: input.command?.entryId ?? context.newId(),
    content: input.content,
    revision: 1,
    status: 'queued',
    createdAt: context.now,
    updatedAt: context.now,
    ...(input.submission ? { submission: { ...input.submission } } : {}),
  };
  next.entries.push(entry);
  if (input.command) recordAppliedCommand(next, input.command, 'create', context);
  bump(next, context.now);
  return accepted(next, { entryId: entry.id, entry: toQueueEntry(entry), duplicate: false }, true);
}

export function enqueueControlInput(
  current: StoredChatExecutionControlState,
  input: Omit<StoredControlInputEntry, 'id'>,
  context: TransitionContext,
): ControlTransition<StoredControlInputEntry> {
  const next = cloneStoredChatExecutionControl(current);
  if (next.controlEntries.length >= MAX_CONTROL_INPUT_ENTRIES) {
    return rejected(current, { code: 'CONTROL_INPUT_QUEUE_FULL' });
  }
  const entry: StoredControlInputEntry = {
    id: context.newId(),
    ...input,
    receipt: {
      ...input.receipt,
      detail: { ...input.receipt.detail },
    },
  };
  next.controlEntries.push(entry);
  return acceptedInternal(next, cloneControlInputEntry(entry));
}

export function replaceQueueEntry(
  current: StoredChatExecutionControlState,
  input: {
    entryId: string;
    content: string;
    expectedRevision: number;
    command?: QueueCommandIdentity;
  },
  context: TransitionContext,
): ControlTransition<QueueMutationValue> {
  const next = cloneStoredChatExecutionControl(current);
  if (input.command) {
    const applied = findAppliedCommand(next, input.command);
    if (applied) {
      const entry = next.entries.find((candidate) => candidate.id === applied.entryId);
      return accepted(next, {
        entryId: applied.entryId,
        entry: entry ? toQueueEntry(entry) : null,
        duplicate: true,
      }, false);
    }
  }

  const entry = next.entries.find((candidate) => candidate.id === input.entryId);
  if (!entry) return rejected(current, missingEntryRejection(current, input.entryId));
  if (entry.status !== 'queued') {
    return rejected(current, {
      code: entry.status === 'steering' ? 'QUEUE_ENTRY_IN_FLIGHT' : 'QUEUE_ENTRY_ALREADY_SENT',
      entryId: input.entryId,
    });
  }
  if (entry.revision !== input.expectedRevision) {
    return rejected(current, {
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      entryId: input.entryId,
      actualRevision: entry.revision,
    });
  }

  entry.content = input.content;
  entry.revision += 1;
  entry.updatedAt = context.now;
  if (input.command) recordAppliedCommand(next, input.command, 'replace', context);
  bump(next, context.now);
  return accepted(next, { entryId: entry.id, entry: toQueueEntry(entry), duplicate: false }, true);
}

export function deleteQueueEntry(
  current: StoredChatExecutionControlState,
  input: { entryId: string; command?: QueueCommandIdentity },
  context: TransitionContext,
): ControlTransition<QueueMutationValue> {
  const next = cloneStoredChatExecutionControl(current);
  if (input.command) {
    const applied = findAppliedCommand(next, input.command);
    if (applied) {
      return accepted(next, {
        entryId: applied.entryId,
        entry: null,
        duplicate: true,
      }, false);
    }
  }

  const index = next.entries.findIndex((entry) => entry.id === input.entryId);
  if (index < 0) return rejected(current, missingEntryRejection(current, input.entryId));
  if (next.entries[index].status !== 'queued') {
    return rejected(current, {
      code: next.entries[index].status === 'steering'
        ? 'QUEUE_ENTRY_IN_FLIGHT'
        : 'QUEUE_ENTRY_ALREADY_SENT',
      entryId: input.entryId,
    });
  }

  next.entries.splice(index, 1);
  if (!hasPendingTurnInput(next)) {
    next.pause = null;
    delete next.resumePauses;
  }
  if (input.command) recordAppliedCommand(next, input.command, 'delete', context);
  bump(next, context.now);
  return accepted(next, { entryId: input.entryId, entry: null, duplicate: false }, true);
}

export function moveQueueEntry(
  current: StoredChatExecutionControlState,
  input: {
    entryId: string;
    targetEntryId: string;
    placement: QueueEntryPlacement;
    expectedReorderRevision: number;
    expectedSourceRevision: number;
    expectedTargetRevision: number;
    command?: QueueCommandIdentity;
  },
  context: TransitionContext,
): ControlTransition<QueueMoveMutationValue> {
  const next = cloneStoredChatExecutionControl(current);
  if (input.command) {
    const applied = findAppliedCommand(next, input.command);
    if (applied) {
      const entry = next.entries.find((candidate) => candidate.id === applied.entryId);
      return accepted(next, {
        entryId: applied.entryId,
        entry: entry ? toQueueEntry(entry) : null,
        duplicate: true,
        rebased: null,
      }, false);
    }
  }

  const source = next.entries.find((entry) => entry.id === input.entryId);
  if (!source) return rejected(current, missingEntryRejection(current, input.entryId));
  if (source.status !== 'queued') {
    return rejected(current, {
      code: source.status === 'steering' ? 'QUEUE_ENTRY_IN_FLIGHT' : 'QUEUE_ENTRY_ALREADY_SENT',
      entryId: input.entryId,
    });
  }
  if (source.revision !== input.expectedSourceRevision) {
    return rejected(current, {
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      entryId: input.entryId,
      actualRevision: source.revision,
    });
  }
  if (next.reorderRevision !== input.expectedReorderRevision) {
    return rejected(current, { code: 'QUEUE_ENTRY_REORDER_CONFLICT' });
  }

  const target = next.entries.find((entry) => entry.id === input.targetEntryId);
  const recentlyDispatchedTarget = next.recentlyDispatched.find(
    (entry) => entry.entryId === input.targetEntryId,
  );
  const targetWasDispatched = !target && recentlyDispatchedTarget !== undefined;
  if (target && target.revision !== input.expectedTargetRevision) {
    return rejected(current, {
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      entryId: input.targetEntryId,
      actualRevision: target.revision,
    });
  }
  if (
    !target
    && recentlyDispatchedTarget
    && recentlyDispatchedTarget.revision !== input.expectedTargetRevision
  ) {
    return rejected(current, {
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      entryId: input.targetEntryId,
      actualRevision: recentlyDispatchedTarget.revision,
    });
  }
  if (!target && !targetWasDispatched) {
    return rejected(current, { code: 'QUEUE_ENTRY_REORDER_CONFLICT' });
  }

  const queuedOrderBefore = next.entries
    .filter(isPendingQueueEntry)
    .map((entry) => entry.id);
  next.entries.splice(next.entries.indexOf(source), 1);

  if (targetWasDispatched) {
    const firstQueuedIndex = next.entries.findIndex(isPendingQueueEntry);
    next.entries.splice(firstQueuedIndex < 0 ? next.entries.length : firstQueuedIndex, 0, source);
  } else {
    const targetIndex = next.entries.findIndex((entry) => entry.id === input.targetEntryId);
    const insertionIndex = input.placement === 'before' ? targetIndex : targetIndex + 1;
    next.entries.splice(insertionIndex, 0, source);
  }

  const queuedOrderAfter = next.entries
    .filter(isPendingQueueEntry)
    .map((entry) => entry.id);
  const orderChanged = queuedOrderBefore.some(
    (entryId, index) => queuedOrderAfter[index] !== entryId,
  );
  if (orderChanged) next.reorderRevision += 1;
  if (input.command) recordAppliedCommand(next, input.command, 'move', context);

  const changed = orderChanged || Boolean(input.command);
  if (changed) bump(next, context.now);
  return accepted(next, {
    entryId: source.id,
    entry: toQueueEntry(source),
    duplicate: false,
    rebased: targetWasDispatched,
  }, changed);
}

export function clearQueue(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  next.entries = [];
  next.pause = null;
  delete next.resumePauses;
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function pauseQueue(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  if (!hasPendingTurnInput(next) || next.pause) {
    return accepted(next, undefined, false);
  }
  next.pause = { id: context.newId(), kind: 'manual', pausedAt: context.now };
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function resumeQueue(
  current: StoredChatExecutionControlState,
  pauseId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  if (!next.pause) return accepted(next, undefined, false);
  if (next.pause.id !== pauseId) return rejected(current, { code: 'QUEUE_PAUSE_CHANGED' });
  const [resumePause, ...remainingPauses] = next.resumePauses ?? [];
  next.pause = resumePause ?? null;
  if (remainingPauses.length > 0) next.resumePauses = remainingPauses;
  else delete next.resumePauses;
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function dequeueNextTurn(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<DequeuedTurnInput | null> {
  const next = cloneStoredChatExecutionControl(current);
  if (next.pause) return accepted(next, null, false);
  if (next.entries.some((entry) => entry.status === 'steering')) {
    return accepted(next, null, false);
  }
  const controlEntry = next.controlEntries.shift();
  if (controlEntry) {
    return acceptedInternal(next, {
      kind: 'control',
      entry: cloneControlInputEntry(controlEntry),
    });
  }
  const entry = next.entries.find((candidate) => candidate.status === 'queued');
  if (!entry) return accepted(next, null, false);

  next.entries.splice(next.entries.indexOf(entry), 1);
  next.recentlyDispatched = [
    ...next.recentlyDispatched.filter((candidate) => candidate.entryId !== entry.id),
    { entryId: entry.id, revision: entry.revision, dispatchedAt: context.now },
  ].slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
  bump(next, context.now);
  return accepted(next, {
    kind: 'user',
    entry: cloneQueueEntry(entry),
  }, true);
}

export function reserveQueueSteer(
  current: StoredChatExecutionControlState,
  input: {
    entryId: string;
    expectedRevision: number;
    expectedReorderRevision: number;
  },
  context: TransitionContext,
): ControlTransition<ReservedQueueSteer> {
  const next = cloneStoredChatExecutionControl(current);
  const entry = next.entries.find((candidate) => candidate.id === input.entryId);
  if (!entry) return rejected(current, missingEntryRejection(current, input.entryId));
  if (entry.status === 'steering' || next.entries.some((candidate) => candidate.status === 'steering')) {
    return rejected(current, { code: 'QUEUE_ENTRY_IN_FLIGHT', entryId: input.entryId });
  }
  if (entry.revision !== input.expectedRevision) {
    return rejected(current, {
      code: 'QUEUE_ENTRY_REVISION_CONFLICT',
      entryId: input.entryId,
      actualRevision: entry.revision,
    });
  }
  if (next.reorderRevision !== input.expectedReorderRevision) {
    return rejected(current, { code: 'QUEUE_ENTRY_REORDER_CONFLICT' });
  }
  const head = next.entries.find((candidate) => candidate.status === 'queued');
  if (head?.id !== entry.id) {
    return rejected(current, { code: 'QUEUE_ENTRY_REORDER_CONFLICT' });
  }

  entry.status = 'steering';
  bump(next, context.now);
  return accepted(next, {
    entry: cloneQueueEntry(entry),
  }, true);
}

export function releaseQueueSteer(
  current: StoredChatExecutionControlState,
  entryId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  const entry = next.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return accepted(next, undefined, false);
  if (entry.status !== 'steering') {
    return rejected(current, { code: 'QUEUE_ENTRY_IN_FLIGHT', entryId });
  }
  entry.status = 'queued';
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function consumeQueueSteer(
  current: StoredChatExecutionControlState,
  entryId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  const index = next.entries.findIndex((candidate) => candidate.id === entryId);
  if (index < 0) return accepted(next, undefined, false);
  const entry = next.entries[index];
  if (entry.status !== 'steering') {
    return rejected(current, { code: 'QUEUE_ENTRY_IN_FLIGHT', entryId });
  }
  next.entries.splice(index, 1);
  next.recentlyDispatched = [
    ...next.recentlyDispatched.filter((candidate) => candidate.entryId !== entry.id),
    { entryId: entry.id, revision: entry.revision, dispatchedAt: context.now },
  ].slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
  if (!hasPendingTurnInput(next)) {
    next.pause = null;
    delete next.resumePauses;
  }
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function requeueAndPause(
  current: StoredChatExecutionControlState,
  input: { entryId: string; kind: AutomaticQueuePauseKind },
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  const entry = next.entries.find((candidate) => candidate.id === input.entryId);
  if (entry) {
    entry.status = 'queued';
    entry.revision += 1;
    entry.updatedAt = context.now;
    next.recentlyDispatched = next.recentlyDispatched.filter(
      (candidate) => candidate.entryId !== input.entryId,
    );
  }
  next.pause = hasPendingTurnInput(next)
    ? {
        id: context.newId(),
        kind: input.kind,
        entryId: input.entryId,
        pausedAt: context.now,
      }
    : null;
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function pauseAfterDispatchFailure(
  current: StoredChatExecutionControlState,
  entryId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  if (!hasPendingTurnInput(next)) return accepted(next, undefined, false);
  next.pause = {
    id: context.newId(),
    kind: 'queued-turn-failed',
    entryId,
    pausedAt: context.now,
  };
  bump(next, context.now);
  return accepted(next, undefined, true);
}

function cloneQueueEntry(entry: StoredQueueEntry): StoredQueueEntry {
  return {
    ...entry,
    ...(entry.submission ? { submission: { ...entry.submission } } : {}),
  };
}

function cloneControlInputEntry(entry: StoredControlInputEntry): StoredControlInputEntry {
  return {
    ...entry,
    receipt: {
      ...entry.receipt,
      detail: { ...entry.receipt.detail },
    },
  };
}
