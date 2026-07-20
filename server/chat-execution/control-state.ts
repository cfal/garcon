import type { ChatExecutionControlState } from '../../common/chat-execution-control.ts';
import type {
  QueueEntry,
  QueuePause,
  RecentlyDispatchedQueueEntry,
} from '../../common/queue-state.ts';
import { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../../common/queue-state.ts';

export { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../../common/queue-state.ts';

export interface StoredQueueDeliveryIdentity {
  clientRequestId: string;
  clientMessageId: string;
  turnId: string;
}

export interface StoredQueueEntry extends QueueEntry {
  status: 'queued' | 'sending';
  delivery?: StoredQueueDeliveryIdentity;
}

export type StoredQueueCommandOperation = 'create' | 'replace' | 'delete';

export interface StoredAppliedQueueCommand {
  key: string;
  operation: StoredQueueCommandOperation;
  entryId: string;
  appliedAt: string;
}

export interface StoredChatExecutionControlState {
  entries: StoredQueueEntry[];
  recentlyDispatched: RecentlyDispatchedQueueEntry[];
  appliedCommands: StoredAppliedQueueCommand[];
  pause: QueuePause | null;
  resumePauses?: QueuePause[];
  version: number;
  updatedAt: string | null;
}

export const MAX_STORED_APPLIED_QUEUE_COMMANDS = 1000;

export function emptyStoredChatExecutionControl(): StoredChatExecutionControlState {
  return {
    entries: [],
    recentlyDispatched: [],
    appliedCommands: [],
    pause: null,
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
      ...(entry.delivery ? { delivery: { ...entry.delivery } } : {}),
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

export function toClientChatExecutionControlState(
  control: StoredChatExecutionControlState,
): ChatExecutionControlState {
  return {
    queue: {
      entries: control.entries
        .filter((entry) => entry.status === 'queued')
        .map(({ status: _status, delivery: _delivery, ...entry }) => ({ ...entry })),
      dispatchingEntryId: control.entries.find((entry) => entry.status === 'sending')?.id ?? null,
      recentlyDispatched: control.recentlyDispatched
        .slice(-MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES)
        .map((entry) => ({ ...entry })),
      pause: control.pause ? { ...control.pause } : null,
    },
    version: control.version,
    updatedAt: control.updatedAt,
  };
}
