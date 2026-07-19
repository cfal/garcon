import type { ScheduledPrompt } from '../../common/scheduled-prompts.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';

export interface ScheduledPromptDispatchOutcome {
  message: string;
}

export class ScheduledPromptDispatcher {
  constructor(
    private readonly deps: {
      commands: Pick<ChatCommandService, 'submitScheduledStart' | 'submitScheduledExistingChat'>;
    },
  ) {}

  async dispatch(scheduledPrompt: ScheduledPrompt, scheduledFor: string): Promise<ScheduledPromptDispatchOutcome> {
    const requestId = `scheduled:${scheduledPrompt.id}:${scheduledFor}`;
    const messageId = `scheduled-message:${scheduledPrompt.id}:${scheduledFor}`;
    if (scheduledPrompt.target.type === 'existing-chat') {
      const outcome = await this.deps.commands.submitScheduledExistingChat({
        chatId: scheduledPrompt.target.chatId,
        command: scheduledPrompt.prompt,
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

    const result = await this.deps.commands.submitScheduledStart({
      clientRequestId: requestId,
      clientMessageId: messageId,
      agentId: scheduledPrompt.target.agentId,
      projectPath: scheduledPrompt.target.projectPath,
      command: scheduledPrompt.prompt,
      model: scheduledPrompt.target.model,
      apiProviderId: scheduledPrompt.target.apiProviderId,
      modelEndpointId: scheduledPrompt.target.modelEndpointId,
      modelProtocol: scheduledPrompt.target.modelProtocol,
      permissionMode: scheduledPrompt.target.permissionMode,
      thinkingMode: scheduledPrompt.target.thinkingMode,
      agentSettingsById: scheduledPrompt.target.agentSettingsById,
      tags: scheduledPrompt.target.tags,
    });
    if (!result.chatId) throw new Error('Scheduled chat start did not return a chat ID');
    return {
      message: `Prompt executed successfully; created chat ${result.chatId}.`,
    };
  }
}
