import crypto from 'node:crypto';
import {
  parseChatRowContent,
  type AddChatRowRequest,
  type AddChatRowResponse,
  type ChatRowTargetResponse,
} from '@garcon/common/chat-row-contracts';
import type { AddRowCliCommand } from './args.js';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';

export interface ChatRowClient {
  getChatRowTarget(chatId: string, signal?: AbortSignal): Promise<ChatRowTargetResponse>;
  addChatRow(request: AddChatRowRequest, signal?: AbortSignal): Promise<AddChatRowResponse>;
}

export function validateAddRowContent(content: string): string {
  try {
    return parseChatRowContent(content);
  } catch (error) {
    throw new CliError(
      'arguments',
      error instanceof Error ? error.message : 'row content is invalid',
      2,
      { cause: error },
    );
  }
}

export async function runAddRow(
  command: AddRowCliCommand,
  content: string,
  client: ChatRowClient,
  output: CliOutput,
  signal?: AbortSignal,
  createId: () => string = crypto.randomUUID,
): Promise<void> {
  const validatedContent = validateAddRowContent(content);
  const target = await client.getChatRowTarget(command.chatId, signal);
  const clientRequestId = createId();
  const clientMessageId = createId();
  const response = await client.addChatRow({
    clientRequestId,
    clientMessageId,
    chatId: target.chatId,
    transcriptViewId: target.transcriptViewId,
    presentation: command.presentation,
    format: command.format,
    ...(command.title === undefined ? {} : { title: command.title }),
    content: validatedContent,
  }, signal);
  output.result([
    `chat id: ${response.chatId}`,
    `transcript view id: ${response.transcriptViewId}`,
    `ordinal: ${response.ordinal}`,
    `type: ${response.presentation.style}`,
    `format: ${response.format}`,
    `status: ${response.status}`,
  ].join('\n'));
}
