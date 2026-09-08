import type { AgentChildAdmissionOutcome, AgentResumeOutcomeNoticeDetail, AgentChildRejectionReason } from '../../common/garcon-agent-result.js';
import type { GarconResumeAgentCommand } from '../../common/garcon-resume-agent.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { AgentResumePreparationError } from '../commands/agent-resume-preparation-error.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { CommandValidationError } from '../lib/command-validation-error.js';
import { DomainError } from '../lib/domain-error.js';
import { isRecoverablePreambleAdmissionError } from '../preambles/selection.js';
import { AgentChildTurnReplies, type AgentChildTurnReplyOptions } from './agent-child-turn-replies.js';
import { isDirectDelegatedChild } from './agent-delegation.js';

export interface AgentResumeControllerOptions extends AgentChildTurnReplyOptions {
  readonly commands: Pick<ChatCommandService, 'submitAgentCommandResumeLocked'>;
}

export class AgentResumeController {
  readonly #replies: AgentChildTurnReplies;
  constructor(private readonly options: AgentResumeControllerOptions) {
    this.#replies = new AgentChildTurnReplies(options);
  }

  request(source: AgentCommandSource, command: GarconResumeAgentCommand): void {
    this.#replies.launchChild(source, async (signal) => {
      if (signal.aborted) return null;
      const delegated = this.#delegated(source.chatId, command.chatId);
      const keys = delegated ? [source.chatId, command.chatId] : [source.chatId];
      return this.options.chatMutationLock.runExclusiveMany(keys.map((id) => `chat:${id}`), async () => {
        if (!this.#replies.current(source, signal)) return null;
        let outcome: AgentChildAdmissionOutcome;
        let turnId: string | null = null;
        if (!this.options.isEnabled()) outcome = { status: 'rejected', reason: 'disabled' };
        else if (!delegated || !this.#delegated(source.chatId, command.chatId)) {
          outcome = { status: 'rejected', reason: 'not-delegated' };
        } else {
          try {
            const result = await this.options.commands.submitAgentCommandResumeLocked({
              sourceChatId: source.chatId, sourceViewId: source.viewId, chatId: command.chatId,
              command: command.prompt, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
            }, signal);
            turnId = result.turnId;
            outcome = { status: 'accepted', chatId: command.chatId };
          } catch (error) {
            const child = this.#delegated(source.chatId, command.chatId) ? { chatId: command.chatId } : {};
            if (child.chatId && isRecoverablePreambleAdmissionError(error)) {
              outcome = { status: 'preamble-rejected', chatId: child.chatId,
                reason: error.code === 'PREAMBLE_SLASH_COMMAND_BLOCKED' ? 'slash-command-blocked' : 'composition-invalid' };
            } else {
              const reason = resumeRejectionReason(error);
              outcome = reason ? { status: 'rejected', reason, ...child } : { status: 'outcome-unknown', ...child };
            }
            this.#replies.report(source, 'admission', error);
          }
        }
        if (!this.#replies.current(source, signal)) return null;
        const detail: AgentResumeOutcomeNoticeDetail = {
          type: 'agent-resume-outcome', ref: command.ref, async: command.async,
          requestViewId: source.viewId, requestOrdinal: source.requestOrdinal, ...outcome,
        };
        return { detail, turnId, recorded: this.#replies.record(source, detail) !== null };
      });
    });
  }

  #delegated(sourceChatId: string, targetChatId: string): boolean {
    return isDirectDelegatedChild(sourceChatId, targetChatId, this.options.registry.getChat(targetChatId));
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }
}

function resumeRejectionReason(error: unknown): AgentChildRejectionReason | null {
  if (error instanceof AgentResumePreparationError) return 'target-unavailable';
  if (!(error instanceof DomainError) && !(error instanceof CommandValidationError)) return null;
  switch (error.code) {
    case 'AGENT_RESUME_NOT_DELEGATED': return 'not-delegated';
    case 'SESSION_BUSY': return 'busy';
    case 'SESSION_NOT_FOUND': case 'CHAT_DELETED': return 'target-unavailable';
    case 'STALE_TRANSCRIPT_VIEW': return 'source-unavailable';
    case 'PROJECT_UNAVAILABLE': case 'PROJECT_PATH_NOT_FOUND': case 'PROJECT_PATH_OUTSIDE_BASE': return 'project-unavailable';
    case 'UNSUPPORTED_AGENT': return 'unsupported-agent';
    case 'INCOMPLETE_EXECUTION_CONFIG': case 'VALIDATION_FAILED': return 'invalid-configuration';
    default: return null;
  }
}
