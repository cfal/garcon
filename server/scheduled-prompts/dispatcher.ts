import {
  renderScheduledPrompt,
  scheduledPromptFitsRenderedLimit,
  type ScheduledPrompt,
} from '../../common/scheduled-prompts.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';

export interface ScheduledPromptDispatchOutcome {
  message: string;
}

export class ScheduledPromptDispatcher {
  constructor(
    private readonly deps: {
      commands: Pick<ChatCommandService, 'submitScheduledStart' | 'submitScheduledExistingChat'>;
      chatIds: Pick<ChatIdAllocator, 'allocate'>;
    },
  ) {}

  async dispatch(scheduledPrompt: ScheduledPrompt, scheduledFor: string): Promise<ScheduledPromptDispatchOutcome> {
    const requestId = `scheduled:${scheduledPrompt.id}:${scheduledFor}`;
    const messageId = `scheduled-message:${scheduledPrompt.id}:${scheduledFor}`;
    if (!scheduledPromptFitsRenderedLimit(scheduledPrompt.prompt)) {
      throw new Error('Scheduled prompt exceeds the maximum length after variable expansion');
    }
    if (scheduledPrompt.target.type === 'existing-chat') {
      const outcome = await this.deps.commands.submitScheduledExistingChat({
        chatId: scheduledPrompt.target.chatId,
        command: renderScheduledPrompt(scheduledPrompt.prompt, scheduledPrompt.target.chatId),
        busyBehavior: scheduledPrompt.target.busyBehavior,
        clientRequestId: requestId,
        clientMessageId: messageId,
      });
      if (outcome.type === 'queued') {
        return { message: `Prompt queued for busy chat ${outcome.chatId}.` };
      }
      if (outcome.type === 'skipped-busy') {
        return {
          message: `Prompt skipped because chat ${outcome.chatId} was busy.`,
        };
      }
      return { message: `Prompt sent to chat ${outcome.chatId}.` };
    }

    const chatId = this.deps.chatIds.allocate();
    const result = await this.deps.commands.submitScheduledStart({
      chatId,
      clientRequestId: requestId,
      clientMessageId: messageId,
      agentId: scheduledPrompt.target.agentId,
      projectPath: scheduledPrompt.target.projectPath,
      command: renderScheduledPrompt(scheduledPrompt.prompt, chatId),
      model: scheduledPrompt.target.model,
      apiProviderId: scheduledPrompt.target.apiProviderId,
      modelEndpointId: scheduledPrompt.target.modelEndpointId,
      modelProtocol: scheduledPrompt.target.modelProtocol,
      permissionMode: scheduledPrompt.target.permissionMode,
      thinkingMode: scheduledPrompt.target.thinkingMode,
      agentSettingsById: scheduledPrompt.target.agentSettingsById,
      tags: scheduledPrompt.target.tags,
    });
    if (result.chatId !== chatId) {
      throw new Error('Scheduled chat start did not return the allocated chat ID');
    }
    return {
      message: `Prompt executed successfully; created chat ${result.chatId}.`,
    };
  }
}
