import {
  CHAT_MESSAGES_MAX_LIMIT,
  isUnavailableChatHistoryResponse,
  type ChatHistoryResponse,
  type ChatMessagesRequest,
  type CompleteChatHistoryResponse,
  type TranscriptMessage,
} from '@garcon/common/chat-view';
import {
  transcriptEntryCategoryForMessage,
  type TranscriptEntryOptionalCategory,
} from '@garcon/common/transcript-entry-categories';
import type { ReadCliCommand } from './args.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
import type { CliOutput } from './output.js';
import { formatTranscriptMessage } from './transcript-message-format.js';

export interface CliChatReadResult {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly anchorOrdinal: number;
  readonly beforeContext: number;
  readonly afterContext: number;
  readonly includedCategories: readonly TranscriptEntryOptionalCategory[];
  readonly messages: readonly TranscriptMessage[];
}

export interface ChatReadClient {
  getChatMessages(
    request: ChatMessagesRequest,
    signal?: AbortSignal,
  ): Promise<ChatHistoryResponse>;
}

export async function readChatWindow(
  command: ReadCliCommand,
  client: ChatReadClient,
  signal?: AbortSignal,
): Promise<CliChatReadResult> {
  const newest = requireCompleteHistory(await client.getChatMessages({
    chatId: command.chatId,
    limit: 1,
    ...(command.transcriptViewId === undefined
      ? {}
      : { transcriptViewId: command.transcriptViewId }),
  }, signal));
  if (command.anchorOrdinal > newest.lastOrdinal) {
    throw new CliError(
      'arguments',
      `anchor ordinal ${command.anchorOrdinal} exceeds the transcript watermark ${newest.lastOrdinal}`,
      2,
    );
  }

  const viewId = newest.transcriptViewId;
  const included = new Set(command.includedCategories);
  const retained = (entry: TranscriptMessage) => {
    const category = transcriptEntryCategoryForMessage(entry.message);
    return category === 'conversation' || included.has(category);
  };
  const firstPage = requireCompleteHistory(await client.getChatMessages({
    chatId: command.chatId,
    transcriptViewId: viewId,
    beforeOrdinal: command.anchorOrdinal + 1,
    limit: CHAT_MESSAGES_MAX_LIMIT,
  }, signal));
  const anchor = firstPage.messages.find((entry) => entry.ordinal === command.anchorOrdinal);
  if (!anchor) {
    throw new CliError(
      'arguments',
      `no presented transcript message exists at ordinal ${command.anchorOrdinal}`,
      2,
    );
  }
  if (!retained(anchor)) {
    const category = transcriptEntryCategoryForMessage(anchor.message);
    throw new CliError(
      'arguments',
      `anchor ordinal ${command.anchorOrdinal} is ${category}; rerun with --include ${category}`,
      2,
    );
  }

  let before = firstPage.messages.filter((entry) => (
    entry.ordinal < command.anchorOrdinal && retained(entry)
  ));
  let beforeCursor = firstPage.nextBeforeOrdinal;
  while (before.length < command.beforeContext && beforeCursor !== null) {
    const page = requireCompleteHistory(await client.getChatMessages({
      chatId: command.chatId,
      transcriptViewId: viewId,
      beforeOrdinal: beforeCursor,
      limit: CHAT_MESSAGES_MAX_LIMIT,
    }, signal));
    before = [...page.messages.filter(retained), ...before];
    beforeCursor = page.nextBeforeOrdinal;
  }
  before = command.beforeContext === 0 ? [] : before.slice(-command.beforeContext);

  const after: TranscriptMessage[] = [];
  let lowerOrdinal = command.anchorOrdinal + 1;
  while (after.length < command.afterContext && lowerOrdinal <= newest.lastOrdinal) {
    const upperOrdinal = Math.min(
      newest.lastOrdinal + 1,
      lowerOrdinal + CHAT_MESSAGES_MAX_LIMIT,
    );
    const page = requireCompleteHistory(await client.getChatMessages({
      chatId: command.chatId,
      transcriptViewId: viewId,
      beforeOrdinal: upperOrdinal,
      limit: upperOrdinal - lowerOrdinal,
    }, signal));
    after.push(...page.messages.filter((entry) => (
      entry.ordinal >= lowerOrdinal && entry.ordinal < upperOrdinal && retained(entry)
    )));
    lowerOrdinal = upperOrdinal;
  }

  return {
    chatId: command.chatId,
    transcriptViewId: viewId,
    anchorOrdinal: command.anchorOrdinal,
    beforeContext: command.beforeContext,
    afterContext: command.afterContext,
    includedCategories: [...command.includedCategories],
    messages: [...before, anchor, ...after.slice(0, command.afterContext)],
  };
}

export function formatChatReadResult(result: CliChatReadResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const lines = [
    `chat id: ${result.chatId}`,
    `transcript view: ${result.transcriptViewId}`,
    `anchor ordinal: ${result.anchorOrdinal}`,
  ];
  for (const entry of result.messages) lines.push('', formatTranscriptMessage(entry));
  return lines.join('\n');
}

export async function runChatRead(
  command: ReadCliCommand,
  client: ChatReadClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  try {
    output.result(formatChatReadResult(
      await readChatWindow(command, client, signal),
      command.json,
    ));
  } catch (error) {
    if (error instanceof GarconHttpError && error.errorCode === 'STALE_TRANSCRIPT_VIEW') {
      throw new CliError(
        'chat read',
        'the transcript view changed; rerun search or read without --transcript-view-id',
        3,
        { cause: error },
      );
    }
    throw error;
  }
}

function requireCompleteHistory(response: ChatHistoryResponse): CompleteChatHistoryResponse {
  if (isUnavailableChatHistoryResponse(response)) {
    throw new CliError(
      'chat read',
      `transcript history is unavailable (${response.historyState.errorCode}, retryable: ${response.historyState.retryable ? 'yes' : 'no'})`,
      3,
    );
  }
  return response;
}
