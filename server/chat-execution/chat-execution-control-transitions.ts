import type { AutomaticQueuePauseKind, QueueEntry, QueuePause } from '../../common/queue-state.ts';
import {
  MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES,
  MAX_STORED_APPLIED_QUEUE_COMMANDS,
  cloneStoredChatExecutionControl,
  type StoredAppliedQueueCommand,
  type StoredChatExecutionControlState,
  type StoredQueueEntry,
} from './control-state.ts';

export interface TransitionContext {
  now: string;
  newId(): string;
}

export interface ReceiptRetention {
  protectedKeys: ReadonlySet<string>;
}

export interface QueueCommandIdentity {
  key: string;
  entryId: string;
}

export type TransitionRejection =
  | { code: 'QUEUE_ENTRY_NOT_FOUND'; entryId: string }
  | { code: 'QUEUE_ENTRY_ALREADY_SENT'; entryId: string }
  | { code: 'QUEUE_ENTRY_REVISION_CONFLICT'; entryId: string; actualRevision: number }
  | { code: 'QUEUE_PAUSE_CHANGED' }
  | { code: 'RECOVERED_INPUT_CONTINUATION_CHANGED' }
  | { code: 'RECOVERED_INPUT_CONTINUATION_REQUIRES_QUEUE' };

export type TransitionOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'rejected'; rejection: TransitionRejection };

export interface ControlTransition<T> {
  next: StoredChatExecutionControlState;
  outcome: TransitionOutcome<T>;
  changed: boolean;
}

export interface QueueMutationValue {
  entryId: string;
  entry: QueueEntry | null;
  duplicate: boolean;
}

export interface PoppedQueueEntry {
  entry: StoredQueueEntry;
}

function accepted<T>(
  next: StoredChatExecutionControlState,
  value: T,
  changed: boolean,
): ControlTransition<T> {
  return { next, outcome: { status: 'ok', value }, changed };
}

function rejected<T>(
  current: StoredChatExecutionControlState,
  rejection: TransitionRejection,
): ControlTransition<T> {
  return {
    next: cloneStoredChatExecutionControl(current),
    outcome: { status: 'rejected', rejection },
    changed: false,
  };
}

function bump(control: StoredChatExecutionControlState, now: string): void {
  control.version += 1;
  control.updatedAt = now;
}

function toQueueEntry(entry: StoredQueueEntry): QueueEntry {
  const { status: _status, delivery: _delivery, ...clientEntry } = entry;
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
  receipts: ReceiptRetention,
): void {
  const protectedKeys = new Set(receipts.protectedKeys);
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
  const terminalReceipts = candidates
    .filter((candidate) => !protectedKeys.has(candidate.key))
    .slice(-MAX_STORED_APPLIED_QUEUE_COMMANDS);
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
  input: { content: string; command?: QueueCommandIdentity },
  context: TransitionContext,
  receipts: ReceiptRetention,
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

  const entry: StoredQueueEntry = {
    id: input.command?.entryId ?? context.newId(),
    content: input.content,
    revision: 1,
    status: 'queued',
    createdAt: context.now,
    updatedAt: context.now,
  };
  next.entries.push(entry);
  if (input.command) recordAppliedCommand(next, input.command, 'create', context, receipts);
  bump(next, context.now);
  return accepted(next, { entryId: entry.id, entry: toQueueEntry(entry), duplicate: false }, true);
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
  receipts: ReceiptRetention,
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
    return rejected(current, { code: 'QUEUE_ENTRY_ALREADY_SENT', entryId: input.entryId });
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
  delete entry.delivery;
  if (input.command) recordAppliedCommand(next, input.command, 'replace', context, receipts);
  bump(next, context.now);
  return accepted(next, { entryId: entry.id, entry: toQueueEntry(entry), duplicate: false }, true);
}

export function deleteQueueEntry(
  current: StoredChatExecutionControlState,
  input: { entryId: string; command?: QueueCommandIdentity },
  context: TransitionContext,
  receipts: ReceiptRetention,
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
    return rejected(current, { code: 'QUEUE_ENTRY_ALREADY_SENT', entryId: input.entryId });
  }

  next.entries.splice(index, 1);
  if (!next.entries.some((entry) => entry.status === 'queued')) {
    next.pause = null;
    delete next.resumePauses;
  }
  if (input.command) recordAppliedCommand(next, input.command, 'delete', context, receipts);
  bump(next, context.now);
  return accepted(next, { entryId: input.entryId, entry: null, duplicate: false }, true);
}

export function clearQueue(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  next.entries = next.entries.filter((entry) => entry.status === 'sending');
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
  if (!next.entries.some((entry) => entry.status === 'queued') || next.pause) {
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

export function continueRecoveredInput(
  current: StoredChatExecutionControlState,
  continuationId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  if (next.recoveredInputContinuation?.id !== continuationId) {
    return rejected(current, { code: 'RECOVERED_INPUT_CONTINUATION_CHANGED' });
  }
  if (!next.entries.some((entry) => entry.status === 'queued')) {
    return rejected(current, { code: 'RECOVERED_INPUT_CONTINUATION_REQUIRES_QUEUE' });
  }
  next.recoveredInputContinuation = null;
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function dropRecoveredInputContinuation(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  if (!next.recoveredInputContinuation) return accepted(next, undefined, false);
  next.recoveredInputContinuation = null;
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function consumeEmptyRecoveredInputContinuation(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  if (next.entries.length > 0 || next.pause || !next.recoveredInputContinuation) {
    return accepted(next, undefined, false);
  }
  next.recoveredInputContinuation = null;
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function popNextQueueEntry(
  current: StoredChatExecutionControlState,
  context: TransitionContext,
): ControlTransition<PoppedQueueEntry | null> {
  const next = cloneStoredChatExecutionControl(current);
  if (next.pause || next.recoveredInputContinuation) return accepted(next, null, false);
  if (next.entries.some((entry) => entry.status === 'sending')) return accepted(next, null, false);
  const entry = next.entries.find((candidate) => candidate.status === 'queued');
  if (!entry) return accepted(next, null, false);

  entry.status = 'sending';
  entry.delivery ??= {
    clientRequestId: context.newId(),
    clientMessageId: context.newId(),
    turnId: context.newId(),
  };
  next.recentlyDispatched = [
    ...next.recentlyDispatched.filter((candidate) => candidate.entryId !== entry.id),
    { entryId: entry.id, dispatchedAt: context.now },
  ].slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
  bump(next, context.now);
  return accepted(next, { entry: { ...entry, delivery: { ...entry.delivery } } }, true);
}

export function removeSentQueueEntry(
  current: StoredChatExecutionControlState,
  entryId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  next.entries = next.entries.filter((entry) => entry.id !== entryId);
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function returnUnsentQueueEntry(
  current: StoredChatExecutionControlState,
  entryId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  const entry = next.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry.status !== 'sending') return accepted(next, undefined, false);
  entry.status = 'queued';
  next.recentlyDispatched = next.recentlyDispatched.filter((candidate) => candidate.entryId !== entryId);
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
    next.recentlyDispatched = next.recentlyDispatched.filter(
      (candidate) => candidate.entryId !== input.entryId,
    );
  }
  next.pause = next.entries.some((candidate) => candidate.status === 'queued')
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

export function restoreStoppedQueueEntry(
  current: StoredChatExecutionControlState,
  entryId: string,
  context: TransitionContext,
): ControlTransition<void> {
  const next = cloneStoredChatExecutionControl(current);
  const entry = next.entries.find((candidate) => candidate.id === entryId);
  if (!entry || entry.status !== 'sending') return accepted(next, undefined, false);
  entry.status = 'queued';
  next.recentlyDispatched = next.recentlyDispatched.filter((candidate) => candidate.entryId !== entryId);
  next.pause ??= { id: context.newId(), kind: 'manual', pausedAt: context.now };
  bump(next, context.now);
  return accepted(next, undefined, true);
}

export function installRecoveryPause(
  control: StoredChatExecutionControlState,
  pause: QueuePause,
): boolean {
  if (control.pause?.kind === pause.kind) return false;
  if (control.pause) control.resumePauses = [control.pause, ...(control.resumePauses ?? [])];
  control.pause = pause;
  return true;
}
