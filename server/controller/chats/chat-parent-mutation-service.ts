import type { SetChatParentRequest, SetChatParentResponse } from '../../../common/chat-parent-contracts.js';
import { DomainError } from '../../common/domain-error.js';
import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import { ChatRegistryDurabilityUnknownError, type IChatRegistry } from './store.js';

interface Dependencies {
  registry: Pick<IChatRegistry, 'setDelegationParentPhased' | 'reconcileUnknownDurability'>;
  chatMutationLock: Pick<KeyedPromiseLock, 'runExclusiveMany'>;
}

function saveUnknown(): DomainError {
  return new DomainError(
    'CHAT_PARENT_SAVE_UNKNOWN',
    'The parent save may have completed. Inspect the chat before explicitly trying again.',
    503,
  );
}

export class ChatParentMutationService {
  constructor(private readonly deps: Dependencies) {}

  async set(input: SetChatParentRequest): Promise<SetChatParentResponse> {
    const keys = [`chat:${input.chatId}`];
    if (input.parentChatId !== null) keys.push(`chat:${input.parentChatId}`);
    return this.deps.chatMutationLock.runExclusiveMany(keys, async () => {
      try {
        const recovered = await this.deps.registry.reconcileUnknownDurability(input.chatId);
        if (recovered === 'still-unknown') throw saveUnknown();
        const result = recovered === 'unavailable' ? null
          : await this.deps.registry.setDelegationParentPhased(input.chatId, input.parentChatId);
        if (!result) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
        if (result.durability === 'unknown') throw saveUnknown();
        const parentChat = result.entry.parentChat;
        if (parentChat !== null && parentChat.relation !== 'delegation') {
          throw new Error('Delegation setter returned protected lineage');
        }
        return { success: true, chatId: input.chatId, parentChat, changed: result.changed };
      } catch (error) {
        if (error instanceof ChatRegistryDurabilityUnknownError) throw saveUnknown();
        if (error instanceof DomainError) throw error;
        throw new DomainError('CHAT_PARENT_SAVE_FAILED', 'Chat parent could not be saved', 503, true, { cause: error });
      }
    });
  }
}
