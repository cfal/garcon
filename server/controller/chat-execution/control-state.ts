import type { ChatExecutionControlState } from '../../../common/chat-execution-control.ts';
import type {
  QueueEntry,
  QueueEntryAttachment,
  QueuePause,
  RecentlyDispatchedQueueEntry,
} from '../../../common/queue-state.ts';
import type { AgentCommandImage } from '../../../common/ws-requests.ts';
import { MAX_CHAT_ATTACHMENT_TOTAL_BYTES } from '../../../common/attachments.ts';
import { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../../../common/queue-state.ts';
import type { ServerControlReceiptDetail } from '../../../common/transcript-notice-details.ts';

export { MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES } from '../../../common/queue-state.ts';

export interface StoredQueueSubmissionIdentity {
  clientMessageId: string;
  transcriptViewId: string;
  excludedResendOrdinals?: readonly number[];
}

// Payloads are immutable for an entry's lifetime: replacement edits only text.
export interface StoredQueueEntry extends Omit<QueueEntry, 'attachments'> {
  status: 'queued' | 'steering';
  images: readonly AgentCommandImage[];
  submission?: StoredQueueSubmissionIdentity;
}

// Queued payloads stay in controller memory until dispatch, so each chat may
// hold at most two maximum-size messages' worth of attachments.
export const MAX_QUEUED_ATTACHMENT_BYTES = 2 * MAX_CHAT_ATTACHMENT_TOTAL_BYTES;

export function queuedAttachmentBytes(images: readonly AgentCommandImage[]): number {
  return images.reduce((total, image) => {
    const base64 = image.data.slice(image.data.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return total + Math.floor((base64.length * 3) / 4) - padding;
  }, 0);
}

// Names match the transcript row the entry becomes at dequeue.
export function queueEntryAttachments(
  images: readonly AgentCommandImage[],
): QueueEntryAttachment[] {
  return images.map((image, index) => ({
    name: image.name || `image-${index + 1}`,
    mimeType: image.mimeType || 'application/octet-stream',
  }));
}

export function toClientQueueEntry(entry: StoredQueueEntry): QueueEntry {
  const { status: _status, submission: _submission, images, ...clientEntry } = entry;
  return { ...clientEntry, attachments: queueEntryAttachments(images) };
}

export function cloneStoredQueueEntry(entry: StoredQueueEntry): StoredQueueEntry {
  return {
    ...entry,
    images: entry.images.map((image) => ({ ...image })),
    ...(entry.submission ? {
      submission: {
        ...entry.submission,
        ...(entry.submission.excludedResendOrdinals
          ? { excludedResendOrdinals: [...entry.submission.excludedResendOrdinals] }
          : {}),
      },
    } : {}),
  };
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
    readonly detail: ServerControlReceiptDetail;
  } | null;
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
    entries: control.entries.map(cloneStoredQueueEntry),
    controlEntries: control.controlEntries.map((entry) => ({
      ...entry,
      receipt: entry.receipt === null ? null : {
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
      entries: control.entries.map(toClientQueueEntry),
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
