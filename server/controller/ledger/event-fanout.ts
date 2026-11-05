import { ChatInputCommittedMessage, ChatTranscriptHeadUpdatedMessage, ChatTranscriptReplacedMessage } from '../../../common/ws-events.js';
import { RESPONSE_CLASSES, transcriptActivity } from '../../../common/transcript-display-events.js';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { TranscriptCommitEvent } from './service.js';
import { isConversationalLedgerRow } from './contracts.js';
import { ledgerRowsToMessages, ledgerRowsToTranscriptMessages } from './presentation.js';

export interface TranscriptEventFanoutDeps {
  readonly serverInstanceId: string;
  chatExists(chatId: string): boolean;
  schedule(chatId: string, task: () => Promise<void> | void): void;
  broadcast(payload: ChatInputCommittedMessage | ChatTranscriptHeadUpdatedMessage | ChatTranscriptReplacedMessage): void;
  updateMetadata(chatId: string, transcriptViewId: string, messages: readonly ChatMessage[]): void;
  replaceMetadata(chatId: string, transcriptViewId: string): Promise<void>;
  planRevision(chatId: string, viewId: string): number;
  auxiliaryRevision(chatId: string, viewId: string): number;
}

export interface TranscriptEventFanout {
  (event: TranscriptCommitEvent): void;
  flush(chatId: string): void;
  flushAll(): void;
  forget(chatId: string): void;
}

export function createTranscriptEventFanout(deps: TranscriptEventFanoutDeps): TranscriptEventFanout {
  const pending = new Map<string, ChatTranscriptHeadUpdatedMessage>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const forget = (chatId: string) => {
    clearTimeout(timers.get(chatId));
    timers.delete(chatId);
    pending.delete(chatId);
  };
  const flush = (chatId: string) => {
    const head = pending.get(chatId);
    forget(chatId);
    if (head && deps.chatExists(chatId)) deps.broadcast(head);
  };
  const apply = async (event: TranscriptCommitEvent) => {
    if (!deps.chatExists(event.chatId)) return;
    if (event.type === 'view-replaced') {
      flush(event.chatId);
      await deps.replaceMetadata(event.chatId, event.view.viewId);
      if (deps.chatExists(event.chatId)) deps.broadcast(new ChatTranscriptReplacedMessage(event.chatId, event.previousViewId, event.view.viewId, 0));
      return;
    }
    const rows = event.type === 'rows' ? event.rows : [event.row];
    const conversational = ledgerRowsToMessages(rows.filter(isConversationalLedgerRow));
    if (conversational.length) deps.updateMetadata(event.chatId, event.viewId, conversational);
    const facts = transcriptActivity(ledgerRowsToTranscriptMessages(rows));
    const prior = pending.get(event.chatId);
    if (prior && prior.transcriptViewId !== event.viewId) flush(event.chatId);
    const previous = prior?.transcriptViewId === event.viewId ? prior : null;
    const response = { ...facts.responseClassOrdinals };
    for (const key of RESPONSE_CLASSES) response[key] = Math.max(response[key], previous?.responseClassOrdinals[key] ?? 0);
    const activity = [previous?.presentedActivityAt, facts.presentedActivityAt].filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
    pending.set(event.chatId, new ChatTranscriptHeadUpdatedMessage(deps.serverInstanceId, event.chatId, event.viewId,
      rows.at(-1)!.ordinal, activity, facts.preview ?? previous?.preview ?? null, response,
      deps.planRevision(event.chatId, event.viewId), deps.auxiliaryRevision(event.chatId, event.viewId)));
    for (const row of rows) {
      if (row.kind === 'user-input' && row.detail.clientMessageId) deps.broadcast(new ChatInputCommittedMessage(
        deps.serverInstanceId, event.chatId, event.viewId, row.detail.clientMessageId, row.ordinal));
    }
    if (event.type === 'run-ended') { flush(event.chatId); return; }
    if (!timers.has(event.chatId)) {
      const timer = setTimeout(() => {
        // Fences a timer already queued when replacement or an ordered flush retires it.
        deps.schedule(event.chatId, () => { if (timers.get(event.chatId) === timer) flush(event.chatId); });
      }, 250);
      timer.unref?.();
      timers.set(event.chatId, timer);
    }
  };
  return Object.assign((event: TranscriptCommitEvent) => {
    if (deps.chatExists(event.chatId)) deps.schedule(event.chatId, () => apply(event));
  }, { flush, forget, flushAll: () => { for (const chatId of pending.keys()) flush(chatId); } });
}
