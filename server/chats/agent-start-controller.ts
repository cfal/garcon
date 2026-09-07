import type { AgentStartFailureReason, AgentStartOutcome } from '../../common/garcon-command-results.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import { StartSelectionError } from '../../common/start-selection.js';
import type { AgentStartSelectionService } from '../agents/agent-start-selection-service.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import type { AgentCommandSource } from '../ledger/garcon-command-publication.js';
import { DomainError } from '../lib/domain-error.js';
import { CommandValidationError } from '../lib/command-validation-error.js';
import { StartProjectUnavailableError } from '../lib/command-project-path.js';
import { AtomicJsonWriteError } from '../lib/json-file-store.js';
import { isRecoverablePreambleAdmissionError } from '../preambles/selection.js';
import type { SettingsStore } from '../settings/store.js';
import type { ChatIdAllocator } from './chat-id-allocator.js';
import { AgentCommandReplies, type AgentCommandContext } from './agent-command-replies.js';

export interface AgentStartControllerOptions extends AgentCommandContext {
  readonly selection: Pick<AgentStartSelectionService, 'catalog' | 'resolve'>;
  readonly settings: Pick<SettingsStore, 'getExecutionDefaults'>;
  readonly commands: Pick<ChatCommandService, 'submitAgentCommandStart'>;
  readonly chatIds: Pick<ChatIdAllocator, 'allocate'>;
}

export class AgentStartController {
  readonly #replies: AgentCommandReplies;
  constructor(private readonly options: AgentStartControllerOptions) {
    this.#replies = new AgentCommandReplies(options);
  }

  request(source: AgentCommandSource, command: GarconStartAgentCommand): void {
    this.#replies.launch(source, async (signal) => {
      const catalog = await this.options.selection.catalog(command.agentId).then(
        (value) => ({ value }), (error: unknown) => ({ error }),
      );
      return this.options.chatMutationLock.runExclusive(`chat:${source.chatId}`, async () => {
        if (!this.#replies.current(source, signal)) return null;
        let outcome: AgentStartOutcome;
        if (!this.options.isEnabled()) outcome = { status: 'failed', reason: 'disabled' };
        else if ('error' in catalog) {
          this.#replies.report(source, 'selection', catalog.error);
          outcome = { status: 'failed', reason: 'action-failed' };
        } else {
          let childChatId: string | undefined;
          try {
            const parent = this.options.registry.getChat(source.chatId)!;
            const selection = this.options.selection.resolve(
              catalog.value, command, this.options.settings.getExecutionDefaults(), parent.permissionMode,
            );
            const allocated = this.options.chatIds.allocate();
            childChatId = allocated;
            const result = await this.options.commands.submitAgentCommandStart({
              ...selection,
              chatId: allocated,
              parentChatId: source.chatId,
              clientRequestId: crypto.randomUUID(),
              clientMessageId: crypto.randomUUID(),
              command: command.prompt,
              agentId: command.agentId,
              projectPath: parent.projectPath,
            });
            outcome = result.chat
              ? { status: 'created', chatId: allocated }
              : { status: 'outcome-unknown', chatId: allocated };
          } catch (error) {
            const child = childChatId ? this.options.registry.getChat(childChatId) : null;
            if (child && isRecoverablePreambleAdmissionError(error)) {
              outcome = { status: 'preamble-rejected', chatId: childChatId!,
                reason: error.code === 'PREAMBLE_SLASH_COMMAND_BLOCKED' ? 'slash-command-blocked' : 'composition-invalid' };
            } else if (child) outcome = { status: 'outcome-unknown', chatId: childChatId! };
            else if (childChatId && (error instanceof AggregateError || error instanceof AtomicJsonWriteError && error.renamed)) {
              outcome = { status: 'outcome-unknown', chatId: childChatId };
            } else outcome = { status: 'failed', reason: startFailureReason(error) };
            this.#replies.report(source, 'admission', error, {
              type: 'agent-start-outcome', requestViewId: source.viewId, requestOrdinal: source.requestOrdinal, ...outcome,
            });
          }
        }
        if (!this.#replies.current(source, signal)) return null;
        return this.#replies.record(source, {
          type: 'agent-start-outcome', requestViewId: source.viewId,
          requestOrdinal: source.requestOrdinal, ...outcome,
        });
      });
    });
  }

  discardSource(chatId: string): void { this.#replies.discardSource(chatId); }
  shutdown(): void { this.#replies.shutdown(); }
}

function startFailureReason(error: unknown): AgentStartFailureReason {
  if (error instanceof StartProjectUnavailableError) return 'project-unavailable';
  if (error instanceof StartSelectionError) {
    switch (error.code) {
      case 'UNKNOWN_AGENT': return 'unsupported-agent';
      case 'UNKNOWN_PROVIDER': case 'PROVIDER_NOT_SUPPORTED': return 'unknown-provider';
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
