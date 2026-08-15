import {
  ChatMessagesMessage,
  ChatTranscriptReplacedMessage,
} from '../../common/ws-events.js';
import type { ChatMessage } from '../../common/chat-types.js';
import type { ResendCandidate } from '../../common/chat-view.js';
import type { TranscriptCommitEvent } from './service.js';
import {
  ledgerRowsToMessages,
  ledgerRowsToTranscriptMessages,
} from './presentation.js';

export interface TranscriptEventFanoutDeps {
  chatExists(chatId: string): boolean;
  schedule(chatId: string, task: () => void): void;
  broadcast(payload: unknown): void;
  updateMetadata(chatId: string, messages: readonly ChatMessage[]): void;
  replaceMetadata(chatId: string): void;
  resendCandidates(chatId: string): readonly ResendCandidate[];
}

export function createTranscriptEventFanout(
  deps: TranscriptEventFanoutDeps,
): (event: TranscriptCommitEvent) => void {
  return function fanout(event: TranscriptCommitEvent): void {
    if (!deps.chatExists(event.chatId)) return;
    deps.schedule(event.chatId, () => applyTranscriptEvent(deps, event));
  };
}

function applyTranscriptEvent(
  deps: TranscriptEventFanoutDeps,
  event: TranscriptCommitEvent,
): void {
  if (!deps.chatExists(event.chatId)) return;
  if (event.type === 'view-replaced') {
    deps.replaceMetadata(event.chatId);
    deps.broadcast(new ChatTranscriptReplacedMessage(
      event.chatId,
      event.previousViewId,
      event.view.viewId,
      0,
    ));
    return;
  }

  const rows = event.type === 'rows' ? event.rows : [event.row];
  const messages = ledgerRowsToTranscriptMessages(rows);
  const conversationalMessages = ledgerRowsToMessages(rows.filter((row) => (
    row.kind === 'user-input' || row.kind === 'provider-row'
  )));
  if (conversationalMessages.length > 0) {
    deps.updateMetadata(event.chatId, conversationalMessages);
  }
  deps.broadcast(new ChatMessagesMessage(
    event.chatId,
    event.viewId,
    messages,
    rows[0]!.ordinal,
    rows.at(-1)!.ordinal,
    [...deps.resendCandidates(event.chatId)],
    event.type === 'run-ended' ? event.runId : undefined,
  ));
}
