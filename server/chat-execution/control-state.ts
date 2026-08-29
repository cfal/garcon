import type { ChatExecutionControlState } from '../../common/chat-execution-control.ts';
import type {
  QueueEntry,
  QueuePause,
  RecentlyDispatchedQueueEntry,
} from '../../common/queue-state.ts';
import { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../../common/queue-state.ts';
import type { InterAgentMessageReceivedNoticeDetail } from '../../common/transcript-notice-details.ts';

export { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../../common/queue-state.ts';

export interface StoredQueueSubmissionIdentity {
  clientMessageId: string;
  transcriptViewId: string;
  excludedResendOrdinals?: readonly number[];
}

export interface StoredQueueEntry extends QueueEntry {
  status: 'queued' | 'steering';
  submission?: StoredQueueSubmissionIdentity;
}

export const MAX_CONTROL_INPUT_ENTRIES = 64;

export interface StoredControlInputEntry {
  readonly id: string;
  readonly content: string;
  readonly transcriptViewId: string;
  readonly createdAt: string;
  readonly receipt: {
    readonly title: string;
    readonly content: string;
    readonly detail: InterAgentMessageReceivedNoticeDetail;
  };
}

export type StoredQueueCommandOperation = 'create' | 'replace' | 'delete' | 'move';

export interface StoredAppliedQueueCommand {
  key: string;
  operation: StoredQueueCommandOperation;
  entryId: string;
  appliedAt: string;
}

export interface StoredChatExecutionControlState {
  serverInstanceId: string;
  entries: StoredQueueEntry[];
  controlEntries: StoredControlInputEntry[];
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  appliedCommands: StoredAppliedQueueCommand[];
  pause: QueuePause | null;
  resumePauses?: QueuePause[];
  reorderRevision: number;
  version: number;
  updatedAt: string | null;
}

export const MAX_STORED_APPLIED_QUEUE_COMMANDS = 1000;

export function emptyStoredChatExecutionControl(
  serverInstanceId: string,
): StoredChatExecutionControlState {
  return {
    serverInstanceId,
    entries: [],
    controlEntries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
    reorderRevision: 0,
    version: 0,
    updatedAt: null,
  };
}

export function cloneStoredChatExecutionControl(
  control: StoredChatExecutionControlState,
): StoredChatExecutionControlState {
  const clone = {
    ...control,
    entries: control.entries.map((entry) => ({
      ...entry,
      ...(entry.submission ? {
        submission: {
          ...entry.submission,
          ...(entry.submission.excludedResendOrdinals
            ? { excludedResendOrdinals: [...entry.submission.excludedResendOrdinals] }
            : {}),
        },
      } : {}),
    })),
    controlEntries: control.controlEntries.map((entry) => ({
      ...entry,
      receipt: {
        ...entry.receipt,
        detail: { ...entry.receipt.detail },
      },
    })),
    recentlyDispatched: control.recentlyDispatched.map((entry) => ({ ...entry })),
    appliedCommands: control.appliedCommands.map((command) => ({ ...command })),
    pause: control.pause ? { ...control.pause } : null,
  };
  if (control.resumePauses?.length) {
    clone.resumePauses = control.resumePauses.map((pause) => ({ ...pause }));
  } else {
    delete clone.resumePauses;
  }
  return clone;
}

export function hasPendingTurnInput(control: StoredChatExecutionControlState): boolean {
  return control.controlEntries.length > 0 || control.entries.length > 0;
}

export function toClientChatExecutionControlState(
  control: StoredChatExecutionControlState,
): ChatExecutionControlState {
  return {
    serverInstanceId: control.serverInstanceId,
    queue: {
      entries: control.entries
        .map(({ status: _status, submission: _submission, ...entry }) => ({ ...entry })),
      steeringEntryId: control.entries.find((entry) => entry.status === 'steering')?.id ?? null,
      recentlyDispatched: control.recentlyDispatched
        .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES)
        .map((entry) => ({ ...entry })),
      pause: control.pause ? { ...control.pause } : null,
      reorderRevision: control.reorderRevision,
    },
    version: control.version,
    updatedAt: control.updatedAt,
  };
}
