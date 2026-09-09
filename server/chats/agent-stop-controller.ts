import type { GarconStopAgentCommand } from '../../common/garcon-stop-agent.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { AgentCommandReplies, type AgentCommandContext } from './agent-command-replies.js';
import { isDirectDelegatedChild } from './agent-delegation.js';

export interface AgentStopControllerOptions extends AgentCommandContext {
  readonly commands: Pick<ChatCommandService, 'submitAgentCommandStopLocked'>;
}

export class AgentStopController {
  readonly #operations: AgentCommandReplies;

  constructor(private readonly options: AgentStopControllerOptions) {
    this.#operations = new AgentCommandReplies(options);
  }

  request(source: AgentCommandSource, command: GarconStopAgentCommand): void {
    this.#operations.launch(source, async (signal) => {
      if (signal.aborted) return;
      const delegated = this.#isDirectDelegatedChild(source.chatId, command.chatId);
      const chatIds = delegated ? [source.chatId, command.chatId] : [source.chatId];
      const lockKeys = chatIds.map((id) => `chat:${id}`);
      await this.options.chatMutationLock.runExclusiveMany(lockKeys, async () => {
        if (!this.#operations.current(source, signal) || !this.options.isEnabled()) return;
        if (!delegated || !this.#isDirectDelegatedChild(source.chatId, command.chatId)) return;
        await this.options.commands.submitAgentCommandStopLocked({
          sourceChatId: source.chatId,
          sourceViewId: source.viewId,
          chatId: command.chatId,
          remove: command.remove,
        }, signal);
      });
    });
  }

  #isDirectDelegatedChild(sourceChatId: string, targetChatId: string): boolean {
    return isDirectDelegatedChild(sourceChatId, targetChatId, this.options.registry.getChat(targetChatId));
  }

  discardSource(chatId: string): void {
    this.#operations.discardSource(chatId);
  }

  shutdown(): void {
    this.#operations.shutdown();
  }
}
