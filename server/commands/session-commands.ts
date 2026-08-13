import crypto from 'crypto';
import { promises as fs } from 'fs';
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
import {
  toClientChatExecutionControlState,
} from '../chat-execution/control-state.ts';
import { createLogger } from '../lib/log.js';
import { withCurrentExecutionControl } from '../lib/command-execution-control-error.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
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
      options: input.handoff ? {} : runOptionsForCommand(input),
      expectedAgentId: input.expectedAgentId,
      tagsToAdd: input.tagsToAdd,
      permissionFallbackPolicy: input.permissionFallbackPolicy,
      handoff: input.handoff,
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
        source: chat,
        permissionFallbackPolicy: input.permissionFallbackPolicy,
        service: this.deps.handoffs,
        execution: this.deps.queue,
      });
      await this.support.assertAttachmentsSupported({
        ...handoffCommand.target, attachments: input.images ?? [],
      });
      normalizedInput.options = handoffCommand.options;
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
      const catalog = await this.deps.agents.getAgentCatalogEntry(chat.agentId);
      if (!catalog) {
        throw new CommandValidationError(
          'UNSUPPORTED_AGENT',
          `Unsupported agent: ${chat.agentId}`,
          422,
        );
      }
      if (
        input.permissionMode !== undefined
        && !catalog.supportedPermissionModes.includes(input.permissionMode)
      ) {
        throw new CommandValidationError(
          'VALIDATION_FAILED',
          `Permission mode ${input.permissionMode} is not supported by ${chat.agentId}`,
          422,
        );
      }
      if (
        input.thinkingMode !== undefined
        && !catalog.supportedThinkingModes.includes(input.thinkingMode)
      ) {
        throw new CommandValidationError(
          'VALIDATION_FAILED',
          `Thinking mode ${input.thinkingMode} is not supported by ${chat.agentId}`,
          422,
        );
      }
    }

    const result = await this.support.submitHttpRun(normalizedInput);
    if (input.tagsToAdd?.length) this.deps.chats.addTags(input.chatId, input.tagsToAdd);
    return result;
  }

  async deleteChat(input: DeleteChatInput): Promise<{ success: true; chatId: string }> {
    const chatId = input.chatId.trim();
    if (!chatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'chatId is required');
    }
    return this.support.withChatMutationLock(chatId, () => this.deleteChatLocked(chatId));
  }

  async submitPermissionDecision(input: PermissionDecisionInput): Promise<CommandAcceptedResponse> {
    this.support.requireChat(input.chatId);
    const ledger = await this.deps.ledger.accept({
      commandType: 'permission-decision',
      chatId: input.chatId,
      clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
      payload: {
        chatId: input.chatId,
        permissionRequestId: input.permissionRequestId,
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
        await this.deps.agents.resolvePermission(input.chatId, input.permissionRequestId, {
          allow: input.allow,
          alwaysAllow: input.alwaysAllow,
          response: input.response,
        });
        await this.deps.ledger.settleTerminal(ledger.record.key, 'finished');
      } catch (error) {
        await this.deps.ledger.settleTerminal(ledger.record.key, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof TransientControlActionError) {
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
    return this.support.withChatMutationLock(input.chatId, () => this.submitStopLocked(input));
  }

  async submitInterruptAndSend(input: StopInput): Promise<AgentInterruptAndSendResponse> {
    this.support.requireChat(input.chatId);
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
    this.deps.pendingInputs.clearChat(chatId, 'chat-removed');

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

    const previousStatus = await this.deps.pathCache.resolveProjectPath(chat.projectPath);
    const nextProjectPath = await this.resolveProjectPathForUpdate(input.projectPath);
    const effectiveProjectKey = nextProjectPath;
    if (nextProjectPath === chat.projectPath) {
      return {
        success: true,
        chatId: input.chatId,
        projectPath: chat.projectPath,
        effectiveProjectKey,
        previousProjectPath: chat.projectPath,
        previousEffectiveProjectKey: previousStatus.effectiveProjectKey,
      };
    }

    await this.assertChatIdleForProjectPathUpdate(input.chatId, chat);
    const nativeSession = await this.nativeSessionForProjectPathUpdate(input.chatId, chat);

    const event = {
      chatId: input.chatId,
      projectPath: nextProjectPath,
      effectiveProjectKey,
      previousProjectPath: chat.projectPath,
      previousEffectiveProjectKey: previousStatus.effectiveProjectKey,
    };
    const updated = await runProjectPathUpdateTransaction({
      chatId: input.chatId,
      agentId: chat.agentId,
      fallbackNativeSession:
        nativeSession !== chat.nativeSession ? nativeSession : undefined,
      prepare: () => this.deps.agents.prepareProjectPathUpdate(chat.agentId, {
        chatId: input.chatId,
        agentSessionId: chat.agentSessionId,
        previousProjectPath: chat.projectPath,
        nextProjectPath,
        nativeSession,
      }),
      persist: (nextNativeSession) => this.deps.chats.updateProjectPath(
        input.chatId,
        {
          ...event,
          ...(nextNativeSession !== undefined
            ? { nativeSession: nextNativeSession }
            : {}),
        },
        { flush: true },
      ),
      logger,
    });
    if (!updated) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
    }
    // The registry now holds the relocated native session; refresh the open
    // projection segment so its settled boundary reads the new path.
    this.deps.agents.notifyProjectPathRelocated(input.chatId);

    return {
      success: true,
      chatId: input.chatId,
      projectPath: updated.projectPath,
      effectiveProjectKey,
      previousProjectPath: event.previousProjectPath,
      previousEffectiveProjectKey: event.previousEffectiveProjectKey,
    };
  }

  private async resolveProjectPathForUpdate(projectPath: string): Promise<string> {
    const requestedPath = String(projectPath || '').trim();
    if (!requestedPath) {
      throw new CommandValidationError('VALIDATION_FAILED', 'projectPath is required');
    }

    let resolvedPath: string;
    try {
      resolvedPath = await assertRealWithinProjectBase(requestedPath);
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        throw new CommandValidationError(
          'PROJECT_PATH_OUTSIDE_BASE',
          'Project path is outside the allowed base directory',
          403,
        );
      }
      throw error;
    }

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new CommandValidationError('PROJECT_PATH_NOT_FOUND', `Project path not found: ${resolvedPath}`, 404);
      }
      throw error;
    }

    if (!stat.isDirectory()) {
      throw new CommandValidationError(
        'PROJECT_PATH_NOT_DIRECTORY',
        `Project path is not a directory: ${resolvedPath}`,
        400,
      );
    }

    return resolvedPath;
  }

  private async assertChatIdleForProjectPathUpdate(chatId: string, chat: ChatRegistryEntry): Promise<void> {
    if (chat.agentSessionId && this.deps.agents.isAgentSessionRunning(chat.agentId, chat.agentSessionId)) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a turn is running',
        409,
        true,
      );
    }

    const queue = await this.deps.queue.readChatExecutionControl(chatId);
    const sendingEntry = queue.entries.find((entry) => entry.status === 'sending');
    if (sendingEntry) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a queued turn is dispatching',
        409,
        true,
      );
    }
    const steeringEntry = queue.entries.find((entry) => entry.status === 'steering');
    if (steeringEntry) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a queued message is being steered',
        409,
        true,
      );
    }
    const queuedEntry = queue.entries.find((entry) => entry.status === 'queued');
    if (queuedEntry) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Clear or run queued messages before updating the project path',
        409,
        true,
      );
    }

    if (this.deps.queue.ownsExecution(chatId)) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a turn is being prepared or finalized',
        409,
        true,
      );
    }

    await this.deps.pendingInputs.reconcileRetainedHistory(chatId);
    if (this.deps.pendingInputs.hasInFlightForChat(chatId)) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a submitted message is still pending',
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
