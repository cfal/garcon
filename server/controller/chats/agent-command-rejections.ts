import type { GarconCommandIssue } from '../../../common/garcon-commands.js';
import { garconCommandRejectionContent, garconCommandRejectionGuidance } from '../../../common/garcon-command-rejection.js';
import type { AgentCommandsFeatureSettings } from '../../../common/settings.js';
import type { GarconCommandRejectionSource } from '../ledger/garcon-command-publication.js';
import { AgentCommandReplies, type AgentCommandReplyContext } from './agent-command-replies.js';

interface AgentCommandRejectionOptions extends AgentCommandReplyContext {
  readonly getSettings: () => AgentCommandsFeatureSettings;
}

export class AgentCommandRejections {
  readonly #replies: AgentCommandReplies;

  constructor(private readonly options: AgentCommandRejectionOptions) {
    this.#replies = new AgentCommandReplies(options);
  }

  reject(source: GarconCommandRejectionSource, candidates: readonly GarconCommandIssue[]): void {
    this.#replies.launch(source, async (signal) => {
      if (!this.#replies.current(source, signal)) return;
      const settings = this.options.getSettings();
      const issues = candidates.filter((issue) => commandEnabled(settings, issue.command));
      if (issues.length === 0) return;
      try {
        // A late steer can be acknowledged without being sampled before the turn ends.
        await this.options.execution.queueServerControlInput(source.chatId, {
          content: garconCommandRejectionContent({
            sourceViewId: source.viewId,
            sourceOrdinal: source.noticeOrdinal,
            issues,
            message: garconCommandRejectionGuidance(issues),
          }),
          transcriptViewId: source.viewId,
          createdAt: new Date().toISOString(),
          receipt: null,
        }, signal);
      } catch (error) {
        if (!signal.aborted) this.#replies.report(source, 'result-delivery', error);
      }
    });
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }
}

function commandEnabled(settings: AgentCommandsFeatureSettings, command: GarconCommandIssue['command']): boolean {
  if (!settings.enabled) return false;
  switch (command) {
    case 'start-agent':
      return settings.startAgent;
    case 'resume-agent':
    case 'stop-agent':
      return settings.resumeAgent;
    case 'send-message':
      return settings.sendMessage;
    case 'schedule':
      return settings.schedule;
    default:
      return command.startsWith('ticket-') && settings.tickets;
  }
}
