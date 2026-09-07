import type { CommandAcceptedResponse } from '../../common/chat-command-contracts.js';
import type { CommandTagMutationOutcome } from '../../common/chat-tag-mutations.js';
import type { ChatTagMutationService } from './chat-tag-mutation-service.js';

type ChatTagMutationPort = Pick<ChatTagMutationService, 'applyDeltaWhileChatLocked'>;

export async function applyPostAdmissionChatTags<T extends CommandAcceptedResponse>(
  accepted: T,
  chatId: string,
  tagsToAdd: readonly string[] | undefined,
  chatTags: ChatTagMutationPort,
): Promise<T> {
  if (!tagsToAdd?.length) return accepted;
  let tagMutation: CommandTagMutationOutcome;
  try {
    const result = await chatTags.applyDeltaWhileChatLocked({ chatId, addTags: tagsToAdd });
    tagMutation = { status: 'applied', addedTags: result.addedTags };
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
    tagMutation = code === 'CHAT_TAG_SAVE_UNKNOWN'
      ? { status: 'unknown', errorCode: 'CHAT_TAG_SAVE_UNKNOWN', recoveryRequired: true }
      : { status: 'not-applied', errorCode: 'CHAT_TAG_SAVE_FAILED', retryable: true };
  }
  return { ...accepted, tagMutation };
}
