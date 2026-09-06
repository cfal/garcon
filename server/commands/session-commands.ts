import crypto from 'crypto';
import type {
  AgentInterruptAndSendResponse,
  AgentStopResponse,
  CommandAcceptedResponse,
  ProjectPathPatchResponse,
} from '../../common/chat-command-contracts.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import { isStopSatisfied, type ChatStopOutcome } from '../../common/chat-types.js';
import { prepareAgentHandoffCommand } from '../agents/agent-handoff-command.js';
import { runOptionsForCommand } from '../agents/agent-run-command-input.js';
import { runProjectPathUpdateTransaction } from '../agents/project-path-update-transaction.js';
import type { StartedAgentSession } from '../agents/session-types.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { TranscriptSnapshotReservation } from '../chat-execution/types.ts';
import { DomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import { withCurrentExecutionControl } from '../lib/command-execution-control-error.js';
import { resolveUpdatedProjectPath } from '../lib/command-project-path.js';
import {
  CommandSupport,
  CommandValidationError,
  commandResultFromRecord,
  type CompactInput,
  type DeleteChatInput,
  type PermissionDecisionInput,
  type StopInput,
  type SubmitRunInput,
  type UpdateProjectPathInput,
} from './command-support.js';
import type { CommandLedgerRecord } from './command-ledger.js';
import { TransientControlActionError } from '../chats/chat-transient-feed.js';
import { PermissionNotActionableError } from '../ledger/errors.js';

const logger = createLogger('commands:session');

export class SessionCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async submitRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    return this.support.withChatMutationLock(input.chatId, () =>
      this.submitRunLocked(input),
    );
  }

  private async submitRunLocked(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    await this.support.assertCurrentTranscriptView(input.chatId, input.transcriptViewId);
    const normalizedInput = {
      chatId: input.chatId,
      transcriptViewId: input.transcriptViewId,
      command: input.command,
      images: input.images,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      options: {
        ...(input.handoff ? {} : runOptionsForCommand(input)),
        ...(input.excludedResendOrdinals?.length
          ? { excludedResendOrdinals: input.excludedResendOrdinals }
          : {}),
      },
      expectedAgentId: input.expectedAgentId,
      tagsToAdd: input.tagsToAdd,
      permissionFallbackPolicy: input.permissionFallbackPolicy,
      handoff: input.handoff,
      userMessagePresentation: input.userMessagePresentation,
    };
    const replay = await this.support.replayHttpRun(normalizedInput);
    if (replay) {
      if (input.tagsToAdd?.length) this.deps.chats.addTags(input.chatId, input.tagsToAdd);
      return replay;
    }
    const chat = this.deps.chats.getChat(input.chatId);
    if (!chat) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
    }
    this.support.assertContent(input.command, input.images);
    if (input.expectedAgentId !== undefined && input.expectedAgentId !== chat.agentId) {
      throw new CommandValidationError(
        'EXPECTED_AGENT_MISMATCH',
        `Expected agent ${input.expectedAgentId}, but chat uses ${chat.agentId}`,
        409,
      );
    }
    if (input.handoff) {
      const handoffCommand = await prepareAgentHandoffCommand({
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
        handoff: input.handoff,
        command: input.command,
        source: chat,
        permissionFallbackPolicy: input.permissionFallbackPolicy,
        service: this.deps.handoffs,
        execution: this.deps.queue,
      });
      await this.support.assertAttachmentsSupported({
        ...handoffCommand.target, attachments: input.images ?? [],
      });
      normalizedInput.options = {
        ...handoffCommand.options,
        ...(input.excludedResendOrdinals?.length
          ? { excludedResendOrdinals: input.excludedResendOrdinals }
          : {}),
      };
      const result = await this.support.submitHttpRun(
        normalizedInput,
        handoffCommand.preparation,
      );
      if (input.tagsToAdd?.length) this.deps.chats.addTags(input.chatId, input.tagsToAdd);
      return result;
    }
    if (!input.model && !chat.model) {
      throw new CommandValidationError(
        'INCOMPLETE_EXECUTION_CONFIG',
        'The chat has no model and this turn did not provide one',
        422,
      );
    }
    await this.support.assertAttachmentsSupported({
      agentId: chat.agentId,
      model: input.model ?? chat.model!,
      apiProviderId: input.apiProviderId === undefined ? chat.apiProviderId : input.apiProviderId,
      modelEndpointId: input.modelEndpointId === undefined ? chat.modelEndpointId : input.modelEndpointId,
      attachments: input.images ?? [],
    });
    const effectivePermissionMode = input.permissionMode ?? chat.permissionMode;
    if (
      input.permissionFallbackPolicy === 'require-explicit-bypass'
      && input.permissionMode === undefined
      && (effectivePermissionMode === 'manualBypass' || effectivePermissionMode === 'bypassPermissions')
    ) {
      throw new CommandValidationError(
        'EXPLICIT_BYPASS_REQUIRED',
        `Persisted permission mode ${effectivePermissionMode} requires an explicit override`,
        422,
      );
    }
    if (input.agentSettings !== undefined && input.agentSettings.ownerId !== chat.agentId) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        `agentSettings must be owned by ${chat.agentId}`,
        400,
      );
    }
    const agentSettings = input.agentSettings ?? chat.agentSettingsById[chat.agentId];
    if (!agentSettings || agentSettings.ownerId !== chat.agentId) {
      throw new CommandValidationError(
        'INCOMPLETE_EXECUTION_CONFIG',
        `The chat has no valid settings for agent ${chat.agentId}`,
        422,
      );
    }
    if (input.permissionMode !== undefined || input.thinkingMode !== undefined) {
      this.deps.agents.assertExecutionModeSelectionSupported(chat.agentId, {
        permissionMode: input.permissionMode,
        thinkingMode: input.thinkingMode,
      });
    }

    const result = await this.support.submitHttpRun(normalizedInput);
    if (input.tagsToAdd?.length) this.deps.chats.addTags(input.chatId, input.tagsToAdd);
    return result;
  }

  async deleteChat(input: DeleteChatInput): Promise<{ success: true; chatId: string }> {
    const chatId = input.chatId.trim();
    if (!chatId) throw new CommandValidationError('VALIDATION_FAILED', 'chatId is required');
    this.support.requireChat(chatId);
    this.deps.handoffs.cancelPreparation(chatId);
    return this.support.withChatMutationLock(chatId, () => this.deleteChatLocked(chatId));
  }

  async submitPermissionDecision(input: PermissionDecisionInput): Promise<CommandAcceptedResponse> {
    return this.support.withChatMutationLock(input.chatId, () => this.submitPermissionDecisionLocked(input));
  }

  private async submitPermissionDecisionLocked(
    input: PermissionDecisionInput,
  ): Promise<CommandAcceptedResponse> {
    this.support.requireChat(input.chatId);
    const ledger = await this.deps.ledger.accept({
      commandType: 'permission-decision',
      chatId: input.chatId,
      clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
      payload: {
        chatId: input.chatId,
        permissionOccurrenceId: input.permissionOccurrenceId,
        allow: input.allow,
        alwaysAllow: input.alwaysAllow,
        control: input.control,
        ...(input.response ? { response: input.response } : {}),
      },
    });
    this.support.throwOnConflict(ledger, 'Conflicting permission decision retry');
    if (ledger.kind !== 'duplicate') {
      try {
        this.deps.transientFeeds.validateAction(input.control);
        await this.deps.agents.resolvePermission(input.chatId, input.permissionOccurrenceId, {
          allow: input.allow,
          alwaysAllow: input.alwaysAllow,
          response: input.response,
        }, input.control);
        await this.deps.ledger.settleTerminal(ledger.record.key, 'finished');
      } catch (error) {
        await this.deps.ledger.settleTerminal(ledger.record.key, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (
          error instanceof TransientControlActionError
          || error instanceof PermissionNotActionableError
        ) {
          throw new CommandValidationError(
            'VALIDATION_FAILED',
            'This permission request is no longer actionable',
            409,
            false,
          );
        }
        throw error;
      }
    }
    return commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted');
  }

  async submitStop(input: StopInput): Promise<AgentStopResponse> {
    this.support.requireChat(input.chatId);
    this.support.requireClientRequestId(input.clientRequestId);
    this.deps.handoffs.cancelPreparation(input.chatId);
    return this.support.withChatMutationLock(input.chatId, () => this.submitStopLocked(input));
  }

  async submitInterruptAndSend(input: StopInput): Promise<AgentInterruptAndSendResponse> {
    this.support.requireChat(input.chatId);
    this.support.requireClientRequestId(input.clientRequestId);
    this.deps.handoffs.cancelPreparation(input.chatId);
    return this.support.withChatMutationLock(input.chatId, () => this.submitInterruptAndSendLocked(input));
  }

  async submitCompact(input: CompactInput): Promise<CommandAcceptedResponse> {
    this.support.requireChat(input.chatId);
    return this.support.withChatMutationLock(input.chatId, () => this.submitCompactLocked(input));
  }

  async updateProjectPath(input: UpdateProjectPathInput): Promise<ProjectPathPatchResponse> {
    const chatId = input.chatId.trim();
    if (!chatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'chatId is required');
    }
    return this.support.withChatMutationLock(chatId, () =>
      this.updateProjectPathLocked({
        chatId,
        projectPath: input.projectPath,
      }),
    );
  }

  private async deleteChatLocked(chatId: string): Promise<{ success: true; chatId: string }> {
    this.support.requireChat(chatId);
    this.deps.ledger.beginChatDeletion(chatId);

    let retired: boolean;
    try {
      retired = await this.deps.queue.abortForChatDeletion(chatId);
    } catch (error) {
      await this.deps.ledger.cancelChatDeletion(chatId);
      logger.warn(
        `sessions: abort before deleting ${chatId} failed:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new CommandValidationError(
        'SESSION_BUSY',
        'The active agent session could not be retired for deletion',
        409,
        true,
      );
    }
    if (!retired) {
      await this.deps.ledger.cancelChatDeletion(chatId);
      throw new CommandValidationError(
        'SESSION_BUSY',
        'The active agent session could not be retired for deletion',
        409,
        true,
      );
    }

    // Removes registry state after abort because abortSession resolves the owning agent through the chat entry.
    try {
      await this.deps.ownership.delete(chatId);
    } catch (error) {
      if (this.deps.chats.getChat(chatId)) {
        this.deps.queue.rollbackChatDeletion(chatId);
        await this.deps.ledger.cancelChatDeletion(chatId);
        throw error;
      }
      logger.warn(
        `sessions: deletion cleanup for ${chatId} will resume from the ownership journal:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    await Promise.all([
      this.deps.queue.deleteChatQueueFile(chatId).catch(() => {
        // Queue file may not exist.
      }),
      this.deps.settings.removeFromAllOrderLists(chatId).catch(() => {}),
      this.deps.settings.removeSessionName(chatId).catch(() => {}),
    ]);

    return { success: true, chatId };
  }

  private async submitStopLocked(input: StopInput): Promise<AgentStopResponse> {
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-stop',
      chatId: input.chatId,
      clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, agentId: input.agentId },
    });
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    if (ledger.kind === 'duplicate') {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        outcome: recordedStopOutcome(ledger.record),
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
      };
    }

    try {
      const result = await this.deps.queue.stopActiveTurn(input.chatId);
      const updated = await this.deps.ledger.update(ledger.record.key, {
        status: isStopSatisfied(result.outcome) ? 'finished' : 'failed',
        stopOutcome: result.outcome,
      });
      return {
        ...commandResultFromRecord(updated ?? ledger.record),
        outcome: result.outcome,
        control: toClientChatExecutionControlState(result.control),
      };
    } catch (error) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async submitInterruptAndSendLocked(input: StopInput): Promise<AgentInterruptAndSendResponse> {
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-interrupt-and-send',
      chatId: input.chatId,
      clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, agentId: input.agentId },
    });
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    if (ledger.kind === 'duplicate') {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        outcome: recordedStopOutcome(ledger.record),
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
      };
    }

    try {
      const outcome = await this.deps.queue.interruptActiveTurn(input.chatId);
      const updated = await this.deps.ledger.update(ledger.record.key, {
        status: isStopSatisfied(outcome) ? 'finished' : 'failed',
        stopOutcome: outcome,
      });
      return {
        ...commandResultFromRecord(updated ?? ledger.record),
        outcome,
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
      };
    } catch (error) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async submitCompactLocked(input: CompactInput): Promise<CommandAcceptedResponse> {
    // Compaction starts its own turn and cannot share its agent session with an active turn.
    const chat = this.deps.chats.getChat(input.chatId);
    if (chat?.agentSessionId && this.deps.agents.isAgentSessionRunning(chat.agentId, chat.agentSessionId)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Cannot compact while a turn is running', 409);
    }
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-compact',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        chatId: input.chatId,
        instructions: input.instructions ?? null,
      },
      turnId,
    });
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') this.support.throwRecordedExecutionFailure(ledger.record);

    if (ledger.kind !== 'duplicate') {
      try {
        await this.deps.queue.scheduleDirectOperation({
          command: {
            key: ledger.record.key,
            chatId: input.chatId,
            clientRequestId,
            turnId,
          },
          settlement: this.support.settlement,
          dispatch: (executionAdmission) => this.deps.agents.compactSession(input.chatId, {
            instructions: input.instructions,
            clientRequestId,
            turnId,
            executionAdmission,
          }),
        });
      } catch (error) {
        throw await withCurrentExecutionControl({
          chatId: input.chatId,
          error,
          handoff: false,
          readControl: (chatId) => this.deps.queue.readChatExecutionControl(chatId),
        });
      }
      return commandResultFromRecord(ledger.record);
    }

    return commandResultFromRecord(ledger.record, 'duplicate');
  }

  private async updateProjectPathLocked(input: UpdateProjectPathInput): Promise<ProjectPathPatchResponse> {
    const chat = this.deps.chats.getChat(input.chatId);
    if (!chat) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
    }
    if (!this.deps.agents.supportsUpdateProjectPath(chat.agentId)) {
      throw new CommandValidationError(
        'PROJECT_PATH_UPDATE_UNSUPPORTED',
        `Project path updates are not supported for agent: ${chat.agentId}`,
        422,
      );
    }

    const nextProjectPath = await resolveUpdatedProjectPath(input.projectPath);
    const effectiveProjectKey = nextProjectPath;
    if (nextProjectPath === chat.projectPath) {
      return {
        success: true,
        chatId: input.chatId,
        projectPath: chat.projectPath,
        effectiveProjectKey,
        previousProjectPath: chat.projectPath,
      };
    }

    const reservation = this.reserveProjectPathUpdate(input.chatId);
    try {
      await this.assertChatIdleForProjectPathUpdate(chat);
      await this.deps.agents.currentTranscriptViewId(input.chatId);
      const refreshedChat = this.deps.chats.getChat(input.chatId);
      if (!refreshedChat) {
        throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
      }
      const activeChat = refreshedChat;
      const nativeSession = await this.nativeSessionForProjectPathUpdate(input.chatId, activeChat);

      const event = {
        chatId: input.chatId,
        projectPath: nextProjectPath,
        effectiveProjectKey,
        previousProjectPath: activeChat.projectPath,
      };
      let relocatedSession: StartedAgentSession | null = null;
      const updated = await runProjectPathUpdateTransaction({
        chatId: input.chatId,
        agentId: activeChat.agentId,
        fallbackNativeSession:
          nativeSession !== activeChat.nativeSession ? nativeSession : undefined,
        prepare: () => this.deps.agents.prepareProjectPathUpdate(activeChat.agentId, {
          chatId: input.chatId,
          agentSessionId: activeChat.agentSessionId,
          previousProjectPath: activeChat.projectPath,
          nextProjectPath,
          nativeSession,
        }),
        persist: async (nextNativeSession) => {
          const persisted = await this.deps.chats.updateProjectPath(
            input.chatId,
            {
              ...event,
              ...(nextNativeSession !== undefined
                ? { nativeSession: nextNativeSession }
                : {}),
            },
            { flush: true },
          );
          if (persisted?.agentSessionId && nextNativeSession !== undefined) {
            relocatedSession = {
              agentSessionId: persisted.agentSessionId,
              nativeSession: nextNativeSession,
              nativeSeedReceipt: persisted.nativeSeedReceipt ?? null,
            };
          }
          return persisted;
        },
        logger,
      });
      if (!updated) {
        throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
      }
      await this.deps.queue.discardPendingChatInput(input.chatId);
      if (relocatedSession) {
        try {
          this.deps.agents.publishSessionFact(input.chatId, relocatedSession);
        } catch (error) {
          logger.warn('Project-path session publication failed after persistence', {
            chatId: input.chatId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        success: true,
        chatId: input.chatId,
        projectPath: updated.projectPath,
        effectiveProjectKey,
        previousProjectPath: event.previousProjectPath,
      };
    } finally {
      await this.deps.queue.releaseTranscriptSnapshot(reservation);
    }
  }

  private async assertChatIdleForProjectPathUpdate(chat: ChatRegistryEntry): Promise<void> {
    if (chat.agentSessionId && this.deps.agents.isAgentSessionRunning(chat.agentId, chat.agentSessionId)) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a turn is running',
        409,
        true,
      );
    }

  }

  private reserveProjectPathUpdate(chatId: string): TranscriptSnapshotReservation {
    try {
      return this.deps.queue.reserveTranscriptSnapshot(chatId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'SESSION_BUSY') throw error;
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a turn is being prepared or finalized',
        409,
        true,
      );
    }
  }

  private async nativeSessionForProjectPathUpdate(
    chatId: string,
    chat: ChatRegistryEntry,
  ): Promise<ChatRegistryEntry['nativeSession']> {
    if (chat.nativeSession) return chat.nativeSession;

    const resolved = await this.deps.agents.resolveNativeSession(chat, chatId);
    if (resolved) return resolved;

    if (this.deps.agents.requiresNativePathForProjectPathUpdate(chat.agentId)) {
      throw new CommandValidationError(
        'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
        'Cannot update the project path until the native session can be resolved',
        409,
        true,
      );
    }
    return null;
  }
}

function recordedStopOutcome(
  record: Pick<CommandLedgerRecord, 'status' | 'stopOutcome'>,
): ChatStopOutcome {
  return record.stopOutcome ?? (record.status === 'finished' ? 'interrupt-requested' : 'failed');
}
