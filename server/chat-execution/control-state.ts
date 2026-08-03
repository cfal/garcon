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
  status: 'queued' | 'sending' | 'steering';
  delivery?: StoredQueueDeliveryIdentity;
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
    serverInstanceId: control.serverInstanceId,
    queue: {
      entries: control.entries
        .filter((entry) => entry.status === 'queued' || entry.status === 'steering')
        .map(({ status: _status, delivery: _delivery, ...entry }) => ({ ...entry })),
      dispatchingEntryId: control.entries.find((entry) => entry.status === 'sending')?.id ?? null,
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
