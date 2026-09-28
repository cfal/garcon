import { parseChatMessage, type ChatMessage } from '../../../../common/chat-types.js';
import { isRecord } from '../../../../common/json.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';
import type { HandoffArtifactChatMetadata, RenderedHandoffArtifact } from '../handoff-artifact/model.js';
import { foldHandoffArtifactEntries } from '../handoff-artifact/projection.js';
import { renderFittedHandoffArtifact } from '../handoff-artifact/xml.js';
import {
  assessCarryover,
  fitCompactionPrompt,
  type CarryoverAssessment,
  type CompactionDestination,
  type CompactionPromptFit,
} from './carryover.js';

export interface HandoffArtifactRenderInput {
  readonly chat: HandoffArtifactChatMetadata;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly contextWindowTokens: number;
  readonly entries: readonly TranscriptExportEntry[];
}

// Task parameters exclude the transcript items, which cross to the Worker
// separately in bounded batches.
export type TokenFittingTask =
  | { readonly kind: 'assess-carryover' }
  | {
      readonly kind: 'fit-compaction-prompt';
      readonly destination: CompactionDestination;
      readonly contextWindowTokens: number;
      readonly maximumEntryBudgetTokens: number | null;
    }
  | {
      readonly kind: 'render-handoff-artifact';
      readonly chat: HandoffArtifactChatMetadata;
      readonly transcriptViewId: string;
      readonly lastOrdinal: number;
      readonly contextWindowTokens: number;
    };

export type TokenFittingTaskKind = TokenFittingTask['kind'];

export interface TokenFittingResults {
  readonly 'assess-carryover': CarryoverAssessment;
  readonly 'fit-compaction-prompt': CompactionPromptFit;
  readonly 'render-handoff-artifact': RenderedHandoffArtifact | null;
}

type TaskHandlers = {
  readonly [K in TokenFittingTaskKind]: (
    task: Extract<TokenFittingTask, { readonly kind: K }>,
    items: readonly unknown[],
  ) => TokenFittingResults[K];
};

const TASK_HANDLERS: TaskHandlers = {
  'assess-carryover': (_task, items) => assessCarryover(chatMessages(items)),
  'fit-compaction-prompt': (task, items) => fitCompactionPrompt({
    messages: chatMessages(items),
    destination: task.destination,
    contextWindowTokens: task.contextWindowTokens,
    maximumEntryBudgetTokens: task.maximumEntryBudgetTokens,
  }),
  'render-handoff-artifact': (task, items) => renderFittedHandoffArtifact({
    chat: task.chat,
    transcriptViewId: task.transcriptViewId,
    lastOrdinal: task.lastOrdinal,
    contextWindowTokens: task.contextWindowTokens,
    sourceFold: foldHandoffArtifactEntries(exportEntries(items)),
  }),
};

export const TOKEN_FITTING_TASK_KINDS = Object.keys(TASK_HANDLERS) as readonly TokenFittingTaskKind[];

// Items arrive as structured clones, which drop class prototypes; parsing
// restores the same message instances the ledger would read back.
export function runTokenFittingTask<K extends TokenFittingTaskKind>(
  task: Extract<TokenFittingTask, { readonly kind: K }>,
  items: readonly unknown[],
): TokenFittingResults[K] {
  const handler = TASK_HANDLERS[task.kind] as TaskHandlers[K];
  return handler(task, items);
}

function chatMessages(items: readonly unknown[]): ChatMessage[] {
  return items.map(chatMessage);
}

function exportEntries(items: readonly unknown[]): TranscriptExportEntry[] {
  return items.map((item) => {
    if (!isRecord(item)) throw new Error('Token fitting received an invalid transcript entry');
    const entry = item as unknown as TranscriptExportEntry;
    return entry.kind === 'message' ? { ...entry, message: chatMessage(entry.message) } : entry;
  });
}

function chatMessage(item: unknown): ChatMessage {
  const message = isRecord(item) ? parseChatMessage(item) : null;
  if (!message) throw new Error('Token fitting received an invalid chat message');
  return message;
}
