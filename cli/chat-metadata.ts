import type {
  SetChatArchivedRequest,
  SetChatOrderStateResponse,
  SetChatPinnedRequest,
} from '@garcon/common/chat-order-contracts';
import type {
  SetChatTagsRequest,
  SetChatTagsResponse,
} from '@garcon/common/chat-tags-contracts';
import type {
  UpdateChatTitleRequest,
  UpdateChatTitleResponse,
} from '@garcon/common/chat-title-contracts';
import type {
  ChatOrderMutationCliCommand,
  RenameCliCommand,
  SetTagsCliCommand,
} from './args.js';
import type { CliOutput } from './output.js';

export interface ChatMetadataClient {
  setChatPinned(
    request: SetChatPinnedRequest,
    signal?: AbortSignal,
  ): Promise<SetChatOrderStateResponse>;
  setChatArchived(
    request: SetChatArchivedRequest,
    signal?: AbortSignal,
  ): Promise<SetChatOrderStateResponse>;
  updateChatTitle(
    request: UpdateChatTitleRequest,
    signal?: AbortSignal,
  ): Promise<UpdateChatTitleResponse>;
  setChatTags(
    request: SetChatTagsRequest,
    signal?: AbortSignal,
  ): Promise<SetChatTagsResponse>;
}

function writeMetadataResult(
  output: CliOutput,
  json: boolean,
  response: unknown,
  plainLines: readonly string[],
): void {
  output.result(json ? JSON.stringify(response, null, 2) : plainLines.join('\n'));
}

export async function runChatOrderMutation(
  command: ChatOrderMutationCliCommand,
  client: ChatMetadataClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  let response: SetChatOrderStateResponse;
  if (command.kind === 'pin' || command.kind === 'unpin') {
    response = await client.setChatPinned({
      chatId: command.chatId,
      isPinned: command.kind === 'pin',
    }, signal);
  } else {
    response = await client.setChatArchived({
      chatId: command.chatId,
      isArchived: command.kind === 'archive',
    }, signal);
  }
  writeMetadataResult(output, command.json, response, [
    `chat id: ${response.chatId}`,
    `order group: ${response.orderGroup}`,
    `changed: ${response.changed ? 'yes' : 'no'}`,
  ]);
}

export async function runRename(
  command: RenameCliCommand,
  client: ChatMetadataClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.updateChatTitle({
    chatId: command.chatId,
    title: command.title,
  }, signal);
  writeMetadataResult(output, command.json, response, [
    `chat id: ${response.chatId}`,
    `title: ${response.title}`,
    `changed: ${response.changed ? 'yes' : 'no'}`,
  ]);
}

export async function runSetTags(
  command: SetTagsCliCommand,
  client: ChatMetadataClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.setChatTags({
    chatId: command.chatId,
    tags: [...command.tags],
  }, signal);
  writeMetadataResult(output, command.json, response, [
    `chat id: ${response.chatId}`,
    `tags: ${response.tags.length > 0 ? response.tags.join(', ') : 'none'}`,
    `changed: ${response.changed ? 'yes' : 'no'}`,
  ]);
}
