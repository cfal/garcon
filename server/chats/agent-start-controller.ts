import type { AgentChildRejectionReason, AgentChildAdmissionOutcome, AgentStartOutcomeNoticeDetail } from '../../common/garcon-agent-result.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import { StartSelectionError } from '../../common/start-selection.js';
import type { AgentStartSelectionService } from '../agents/agent-start-selection-service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import { AgentStartCompensatedError } from '../commands/agent-start-compensated-error.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { DomainError } from '../lib/domain-error.js';
import { CommandValidationError } from '../lib/command-validation-error.js';
import { StartProjectUnavailableError } from '../lib/command-project-path.js';
import { AtomicJsonWriteError } from '../lib/json-file-store.js';
import { isRecoverablePreambleAdmissionError } from '../preambles/selection.js';
import type { SettingsStore } from '../settings/store.js';
import type { ChatIdAllocator } from './chat-id-allocator.js';
import { AgentChildTurnReplies, type AgentChildTurnReplyOptions } from './agent-child-turn-replies.js';

export interface AgentStartControllerOptions extends AgentChildTurnReplyOptions {
  readonly selection: Pick<AgentStartSelectionService, 'catalog' | 'resolve'>;
  readonly settings: Pick<SettingsStore, 'getExecutionDefaults'>;
  readonly commands: Pick<ChatCommandService, 'submitAgentCommandStartLocked'>;
  readonly chatIds: Pick<ChatIdAllocator, 'allocate'>;
}

export class AgentStartController {
  readonly #replies: AgentChildTurnReplies;
  constructor(private readonly options: AgentStartControllerOptions) {
    this.#replies = new AgentChildTurnReplies(options);
  }

  request(source: AgentCommandSource, command: GarconStartAgentCommand): void {
    this.#replies.launchChild(source, async (signal) => {
      if (!this.#replies.current(source, signal)) return null;
      let allocated: string;
      try { allocated = this.options.chatIds.allocate(); }
      catch (error) {
        return this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
          if (!this.#replies.current(source, signal)) return null;
          const detail: AgentStartOutcomeNoticeDetail = {
            type: 'agent-start-outcome', ref: command.ref, async: command.async,
            requestViewId: source.viewId, requestOrdinal: source.requestOrdinal,
            status: 'rejected', reason: this.options.isEnabled() ? 'action-failed' : 'disabled',
          };
          this.#replies.report(source, 'allocation', error, detail);
          return { detail, turnId: null, recorded: this.#replies.record(source, detail) !== null };
        });
      }
      const rediscover = Symbol('rediscover');
      for (let attempt = 0; ; attempt++) {
        if (!this.#replies.current(source, signal)) return null;
        const agentId = command.agentId ?? this.options.registry.getChat(source.chatId)!.agentId;
        const catalog = await this.options.selection.catalog(agentId).then(
          (value) => ({ value }), (error: unknown) => ({ error }),
        );
        const result = await this.options.chatMutationLock.runExclusiveMany([`chat:${source.chatId}`, `chat:${allocated}`], async () => {
          if (!this.#replies.current(source, signal)) return null;
          const parent = this.options.registry.getChat(source.chatId)!;
          const agentChanged = agentId !== (command.agentId ?? parent.agentId);
          let outcome: AgentChildAdmissionOutcome;
          let turnId: string | null = null;
          if (!this.options.isEnabled()) outcome = { status: 'rejected', reason: 'disabled' };
          else if (agentChanged) {
            if (attempt < 2) return rediscover;
            outcome = { status: 'rejected', reason: 'action-failed' };
          } else if ('error' in catalog) {
            this.#replies.report(source, 'selection', catalog.error);
            outcome = { status: 'rejected', reason: 'action-failed' };
          } else {
            let childChatId: string | undefined;
            try {
              const selection = this.options.selection.resolve(
                catalog.value, command, this.options.settings.getExecutionDefaults(), parent,
              );
              childChatId = allocated;
              const result = await this.options.commands.submitAgentCommandStartLocked({
                ...selection,
                chatId: allocated,
                parentChatId: source.chatId,
                sourceViewId: source.viewId,
                clientRequestId: crypto.randomUUID(),
                clientMessageId: crypto.randomUUID(),
                command: command.prompt,
                projectPath: parent.projectPath,
                ...(command.title === null ? {} : { title: command.title }),
                ...(command.fork ? { transcriptSnapshot: { viewId: source.viewId, ordinal: source.requestOrdinal } } : {}),
              }, signal);
              turnId = result.turnId;
              outcome = { status: 'accepted', chatId: allocated };
            } catch (error) {
              const child = childChatId ? this.options.registry.getChat(childChatId) : null;
              if (error instanceof AgentStartCompensatedError) outcome = { status: 'rejected', reason: startFailureReason(error.cause) };
              else if (child && isRecoverablePreambleAdmissionError(error)) {
                outcome = { status: 'preamble-rejected', chatId: childChatId!,
                  reason: error.code === 'PREAMBLE_SLASH_COMMAND_BLOCKED' ? 'slash-command-blocked' : 'composition-invalid' };
              } else if (child) outcome = { status: 'outcome-unknown', chatId: childChatId! };
              else if (childChatId && (error instanceof AggregateError || error instanceof AtomicJsonWriteError && error.renamed)) {
                outcome = { status: 'outcome-unknown', chatId: childChatId };
              } else outcome = { status: 'rejected', reason: startFailureReason(error) };
              this.#replies.report(source, 'admission', error, {
                type: 'agent-start-outcome', ref: command.ref, async: command.async,
                requestViewId: source.viewId, requestOrdinal: source.requestOrdinal, ...outcome,
              });
            }
          }
          if (!this.#replies.current(source, signal)) return null;
          const detail: AgentStartOutcomeNoticeDetail = {
            type: 'agent-start-outcome', ref: command.ref, async: command.async, requestViewId: source.viewId,
            requestOrdinal: source.requestOrdinal, ...outcome,
          };
          return { detail, turnId, recorded: this.#replies.record(source, detail) !== null };
        });
        if (result !== rediscover) return result;
      }
    });
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }
}

function startFailureReason(error: unknown): AgentChildRejectionReason {
  if (error instanceof StartProjectUnavailableError) return 'project-unavailable';
  if (error instanceof StartSelectionError) {
    switch (error.code) {
      case 'UNKNOWN_AGENT': return 'unsupported-agent';
      case 'UNKNOWN_PROVIDER': case 'PROVIDER_NOT_SUPPORTED': return 'unknown-provider';
      case 'AMBIGUOUS_PROVIDER': return 'ambiguous-provider';
      case 'AMBIGUOUS_MODEL': return 'ambiguous-model';
      case 'UNKNOWN_MODEL': return 'unknown-model';
      case 'UNSUPPORTED_PERMISSION_MODE': return 'unsupported-permission-mode';
      case 'UNSUPPORTED_REASONING_EFFORT': return 'unsupported-reasoning-effort';
      default: return 'action-failed';
    }
  }
  if (error instanceof DomainError || error instanceof CommandValidationError) {
    switch (error.code) {
      case 'UNSUPPORTED_AGENT': return 'unsupported-agent';
      case 'PROJECT_UNAVAILABLE': case 'PROJECT_PATH_NOT_FOUND': case 'PROJECT_PATH_OUTSIDE_BASE': return 'project-unavailable';
      case 'SESSION_NOT_FOUND': return 'source-unavailable';
    }
  }
  return 'action-failed';
}
