import type { AgentScheduleOutcome } from '../../common/garcon-command-results.js';
import { garconScheduleActionContent, type GarconScheduleCommand } from '../../common/garcon-schedule.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { ScheduledPromptCreationOutcomeUnknownError, type ScheduledPromptScheduler } from '../scheduled-prompts/scheduler.js';
import { ScheduledPromptDomainError } from '../scheduled-prompts/store.js';
import { AgentCommandReplies, type AgentCommandContext } from './agent-command-replies.js';

export interface AgentScheduleControllerOptions extends AgentCommandContext {
  readonly scheduler: Pick<ScheduledPromptScheduler, 'scheduleForChat'>;
}

export class AgentScheduleController {
  readonly #replies: AgentCommandReplies;
  constructor(private readonly options: AgentScheduleControllerOptions) {
    this.#replies = new AgentCommandReplies(options);
  }

  request(source: AgentCommandSource, command: GarconScheduleCommand): void {
    this.#replies.launch(source, async (signal) => {
      const detail = await this.options.chatMutationLock.runExclusive(
      `chat:${source.chatId}`, async () => {
        if (!this.#replies.current(source, signal)) return null;
        let outcome: AgentScheduleOutcome;
        if (!this.options.isEnabled()) outcome = { status: 'failed', reason: 'disabled' };
        else {
          try {
            const { scheduledPrompt } = await this.options.scheduler.scheduleForChat({
              chatId: source.chatId, firstRun: command.firstRun,
              intervalMinutes: command.intervalMinutes, endAtUtc: command.endAtUtc,
              busyBehavior: command.busyBehavior, prompt: garconScheduleActionContent(command.body),
            });
            const schedule = scheduledPrompt.schedule;
            outcome = { status: 'created', scheduleId: scheduledPrompt.id,
              nextRunAt: schedule.nextRunAt,
              intervalMinutes: schedule.type === 'recurring' ? schedule.intervalMinutes : null,
              endAtUtc: schedule.type === 'recurring' ? schedule.endAt : null,
              busyBehavior: command.busyBehavior };
          } catch (error) {
            outcome = error instanceof ScheduledPromptCreationOutcomeUnknownError
              ? { status: 'outcome-unknown', scheduleId: error.scheduleId }
              : { status: 'failed', reason: error instanceof ScheduledPromptDomainError
                ? error.code === 'SCHEDULED_PROMPT_LIMIT_REACHED' ? 'limit-reached'
                  : error.code === 'SESSION_NOT_FOUND' ? 'source-unavailable'
                    : error.code === 'SCHEDULED_PROMPT_VALIDATION_FAILED' ? 'invalid-schedule' : 'action-failed'
                : 'action-failed' };
            this.#replies.report(source, 'persistence', error, {
              type: 'agent-schedule-outcome', requestViewId: source.viewId, requestOrdinal: source.requestOrdinal, ...outcome,
            });
          }
        }
        if (!this.#replies.current(source, signal)) return null;
        return this.#replies.record(source, {
          type: 'agent-schedule-outcome', requestViewId: source.viewId,
          requestOrdinal: source.requestOrdinal, ...outcome,
        });
      },
      );
      if (detail) await this.#replies.deliver(source, detail, signal);
    });
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }
}
