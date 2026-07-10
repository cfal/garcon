import type { ScheduledTask } from '../../common/scheduled-tasks.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { scheduledChatId } from './chat-id.js';

export interface ScheduledTaskDispatchOutcome {
  message: string;
}

export class ScheduledTaskDispatcher {
  constructor(
    private readonly deps: {
      commands: Pick<ChatCommandService, 'submitStart' | 'submitScheduledExistingChat'>;
      chats: Pick<IChatRegistry, 'getChat'>;
    },
  ) {}

  async dispatch(task: ScheduledTask, scheduledFor: string): Promise<ScheduledTaskDispatchOutcome> {
    const requestId = `scheduled:${task.id}:${scheduledFor}`;
    const messageId = `scheduled-message:${task.id}:${scheduledFor}`;
    if (task.target.type === 'existing-chat') {
      const outcome = await this.deps.commands.submitScheduledExistingChat({
        chatId: task.target.chatId,
        command: task.prompt,
        busyBehavior: task.target.busyBehavior,
        clientRequestId: requestId,
        clientMessageId: messageId,
      });
      if (outcome.type === 'queued') {
        return { message: `Task queued for busy chat ${outcome.chatId}.` };
      }
      if (outcome.type === 'skipped-busy') {
        return {
          message: `Task skipped because chat ${outcome.chatId} was busy.`,
        };
      }
      return { message: `Task sent to chat ${outcome.chatId}.` };
    }

    const chatId = scheduledChatId(task.id, scheduledFor);
    if (this.deps.chats.getChat(chatId)) {
      throw new Error(`Scheduled chat ID already exists: ${chatId}`);
    }
    await this.deps.commands.submitStart({
      chatId,
      clientRequestId: requestId,
      clientMessageId: messageId,
      agentId: task.target.agentId,
      projectPath: task.target.projectPath,
      command: task.prompt,
      model: task.target.model,
      apiProviderId: task.target.apiProviderId,
      modelEndpointId: task.target.modelEndpointId,
      modelProtocol: task.target.modelProtocol,
      permissionMode: task.target.permissionMode,
      thinkingMode: task.target.thinkingMode,
      claudeThinkingMode: task.target.claudeThinkingMode,
      ampAgentMode: task.target.ampAgentMode,
    });
    return { message: `Task executed successfully; created chat ${chatId}.` };
  }
}
