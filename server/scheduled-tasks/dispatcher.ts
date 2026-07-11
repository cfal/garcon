import type { ScheduledTask } from '../../common/scheduled-tasks.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';

export interface ScheduledTaskDispatchOutcome {
  message: string;
}

export class ScheduledTaskDispatcher {
  constructor(
    private readonly deps: {
      commands: Pick<ChatCommandService, 'submitScheduledStart' | 'submitScheduledExistingChat'>;
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

    const result = await this.deps.commands.submitScheduledStart({
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
    if (!result.chatId) throw new Error('Scheduled chat start did not return a chat ID');
    return { message: `Task executed successfully; created chat ${result.chatId}.` };
  }
}
