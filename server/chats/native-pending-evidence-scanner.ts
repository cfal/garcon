import { UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { PendingInputHistoryReader } from './chat-message-reader.js';

const NATIVE_EVIDENCE_PAGE_SIZE = 250;

export function nativeUserMessages(messages: readonly ChatMessage[] | null): UserMessage[] {
  return (messages ?? []).filter(
    (message): message is UserMessage => message instanceof UserMessage,
  );
}

export async function scanCurrentNativeUserEvidence(input: {
  readonly chatId: string;
  readonly reader: PendingInputHistoryReader;
  readonly shouldContinue: () => boolean;
  readonly acceptEvidence: (messages: UserMessage[]) => void;
}): Promise<UserMessage[]> {
  if (!input.reader.loadNativeWindow) {
    const messages = nativeUserMessages(await input.reader.loadNativeMessages(input.chatId));
    input.acceptEvidence(messages);
    return messages;
  }
  const signal = new AbortController().signal;
  let offsetFromNewest = 0;
  let nativeRevision: string | null = null;
  let totalNativeMessages: number | null = null;
  let messages: UserMessage[] = [];
  while (input.shouldContinue()) {
    const window = await input.reader.loadNativeWindow({
      chatId: input.chatId,
      limit: NATIVE_EVIDENCE_PAGE_SIZE,
      offsetFromNewest,
      signal,
    });
    if (window.kind === 'snapshot') {
      messages = nativeUserMessages(window.messages);
      input.acceptEvidence(messages);
      return messages;
    }
    if ((nativeRevision !== null && nativeRevision !== window.nativeRevision)
        || (totalNativeMessages !== null
          && totalNativeMessages !== window.totalNativeMessages)) {
      throw new Error('Native transcript changed while pending inputs were reconciled');
    }
    nativeRevision = window.nativeRevision;
    totalNativeMessages = window.totalNativeMessages;
    messages = [...nativeUserMessages(window.messages), ...messages];
    input.acceptEvidence(messages);
    offsetFromNewest += window.messages.length;
    if (offsetFromNewest >= window.totalNativeMessages) return messages;
    if (window.messages.length === 0) {
      throw new Error('Native transcript paging stopped before reaching its beginning');
    }
  }
  return messages;
}
