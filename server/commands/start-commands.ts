import crypto from 'crypto';
import { parseChatRowTitle } from '../../common/chat-row-contracts.js';
import {
  recordsStartupPreferences,
  type StartChatCommandResponse,
} from '../../common/chat-command-contracts.js';

import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import { AgentStartCompensatedError } from './agent-start-compensated-error.js';
import { resolveStartProjectPath } from '../lib/command-project-path.js';
import { createLogger } from '../lib/log.js';
import { createPreambleBoundaryBinding } from '../preambles/boundary.js';
import { resolveNewChatPreambleSelection } from '../preambles/selection.js';
import { frozenConversationDrafts } from '../ledger/projection.js';
import {
  CommandSupport,
  CommandValidationError,
  agentTurnResultFromRecord,
  type ChatStartInput,
  type AgentCommandStartInput,
  type NormalizedChatStart,
  type ScheduledChatStartInput,
} from './command-support.js';
import {
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  commandLedgerKey,
  commandPayloadHash,
  type CommandLedgerRecord,
} from './command-ledger.js';

const logger = createLogger('commands:start');

export class StartCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async submitStart(input: ChatStartInput): Promise<StartChatCommandResponse> {
    const chatId = this.support.requireChatId(input.chatId);
    return this.support.withChatMutationLock(
      chatId,
      () => this.submitStartLocked(input, chatId),
    );
  }

  private async submitStartLocked(
    input: ChatStartInput,
    chatId: NormalizedChatStart['chatId'],
    signal?: AbortSignal,
  ): Promise<StartChatCommandResponse> {
    signal?.throwIfAborted();
    const replay = await this.replayStart(input, chatId);
    if (replay) return replay;
    const normalized = await this.normalizeStart(input, chatId);
    signal?.throwIfAborted();
    return this.submitNormalizedStart(normalized, signal);
  }

  async submitScheduledStart(input: ScheduledChatStartInput): Promise<StartChatCommandResponse> {
    return this.submitStart({
      ...input,
      origin: 'scheduled',
      images: [],
      agentSettings: input.agentSettingsById[input.agentId],
    });
  }

  submitAgentCommandStartLocked(
    input: AgentCommandStartInput,
    signal: AbortSignal,
  ): Promise<StartChatCommandResponse> {
    signal.throwIfAborted();
    this.support.requireChat(input.parentChatId);
    if (this.deps.transcripts.existingCurrentView(input.parentChatId)?.viewId !== input.sourceViewId) {
      throw new CommandValidationError('STALE_TRANSCRIPT_VIEW', 'The requesting transcript view is no longer current', 409);
    }
    if (input.transcriptSnapshot && input.transcriptSnapshot.viewId !== input.sourceViewId) {
      throw new CommandValidationError('STALE_TRANSCRIPT_VIEW', 'Snapshot does not belong to the requesting view', 409);
    }
    return this.submitStartLocked({
      ...input, origin: 'agent-command', images: [], orderedPreambleIds: [],
    }, this.support.requireChatId(input.chatId), signal);
  }

  private async normalizeStart(
    input: ChatStartInput,
    chatId: NormalizedChatStart['chatId'],
  ): Promise<NormalizedChatStart> {
    const images = input.images ?? [];
    const idempotencyProjectPath = String(input.projectPath || '').trim();

    if (!this.deps.agents.hasAgent(input.agentId)) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Unsupported agent: ${input.agentId}`);
    }
    this.deps.agents.assertExecutionModeSelectionSupported(input.agentId, {
      thinkingMode: input.thinkingMode,
    });
    const parentChatId = input.parentChatId === undefined
      ? null
      : this.support.requireChatId(input.parentChatId, 'parentChatId');
    if (parentChatId !== null && !this.deps.chats.getChat(parentChatId)) {
      throw new CommandValidationError(
        'SESSION_NOT_FOUND',
        `Parent chat not found: ${parentChatId}`,
        404,
      );
    }
    const title = input.origin === 'agent-command' ? parseChatRowTitle(input.title) ?? null : null;
    const transcriptSnapshot = input.origin === 'agent-command' ? input.transcriptSnapshot ?? null : null;
    if (transcriptSnapshot) {
      if (parentChatId === null || !Number.isSafeInteger(transcriptSnapshot.ordinal) || transcriptSnapshot.ordinal < 1) {
        throw new CommandValidationError('VALIDATION_FAILED', 'Snapshot requires a committed parent ordinal');
      }
      const tip = this.deps.transcripts.highWatermark(parentChatId);
      if (tip.viewId !== transcriptSnapshot.viewId || transcriptSnapshot.ordinal > tip.ordinal) {
        throw new CommandValidationError('STALE_TRANSCRIPT_VIEW', 'Snapshot is outside the current parent transcript', 409);
      }
    }
    this.support.assertContent(input.command, images);
    await this.support.assertAttachmentsSupported({
      agentId: input.agentId,
      model: input.model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
      attachments: images,
    });

    if (!input.agentSettings || input.agentSettings.ownerId !== input.agentId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'agentSettings must be owned by agentId');
    }

    const projectPath = await resolveStartProjectPath(input.projectPath);
    // Omitted IDs resolve the newest defaults here, at actual creation; an
    // explicit list is proven safe against this same catalog snapshot.
    const preambleSelection = resolveNewChatPreambleSelection({
      catalog: this.deps.preambles.snapshot(),
      canonicalProjectPath: projectPath,
      agentId: input.agentId,
      tags: input.tags ?? [],
      chatId,
      ...(input.orderedPreambleIds === undefined
        ? {}
        : { orderedPreambleIds: input.orderedPreambleIds }),
    });

    return {
      title,
      transcriptSnapshot: transcriptSnapshot ? { ...transcriptSnapshot } : null,
      origin: input.origin,
      chatId,
      parentChatId,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      agentId: input.agentId,
      projectPath,
      idempotencyProjectPath,
      command: input.command,
      images,
      model: input.model,
      apiProviderId: input.apiProviderId ?? null,
      modelEndpointId: input.modelEndpointId ?? null,
      modelProtocol: input.modelProtocol ?? null,
      permissionMode: input.permissionMode,
      thinkingMode: input.thinkingMode,
      agentSettings: input.agentSettings,
      tags: input.tags ?? [],
      userMessagePresentation: input.userMessagePresentation,
      ...(input.orderedPreambleIds === undefined
        ? {}
        : { orderedPreambleIds: input.orderedPreambleIds }),
      preambleSelection,
    };
  }

  private async submitNormalizedStart(input: NormalizedChatStart, signal?: AbortSignal): Promise<StartChatCommandResponse> {
    const existing = this.deps.chats.getChat(input.chatId);
    if (existing || input.transcriptSnapshot && this.deps.transcripts.existingCurrentView(input.chatId)) {
      throw new CommandValidationError(
        'CHAT_ID_COLLISION',
        `Session already exists: ${input.chatId}`,
        409,
      );
    }
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'chat-start',
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      turnId,
      payload: startPayload(input),
    });
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') {
      return this.replayedStart(ledger.record);
    }

    let registered = false;
    let seedOwned = false;
    let titleOwned = false;
    let compensated = false;
    await this.deps.queue.runInitialInput({
      command: {
        key: ledger.record.key,
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
        turnId,
      },
      content: input.command,
      options: {
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        turnId,
        images: input.images.length > 0 ? input.images : undefined,
        agentSettings: input.agentSettings,
      },
      userMessagePresentation: input.userMessagePresentation,
      settlement: this.support.settlement,
      preparation: {
        operation: 'chat-start',
        prepare: async () => {
          signal?.throwIfAborted();
          if (input.transcriptSnapshot) {
            if (this.deps.chats.getChat(input.chatId) || this.deps.transcripts.existingCurrentView(input.chatId)) {
              throw new CommandValidationError('CHAT_ID_COLLISION', 'Snapshot target already exists', 409);
            }
            const rows = frozenConversationDrafts(this.deps.transcripts.rowsThrough(
              input.parentChatId!, input.transcriptSnapshot,
            ));
            seedOwned = true;
            this.deps.transcripts.initializeChat(input.chatId, rows, rows.length + 1);
          }
          registered = this.deps.chats.addChat({
            id: input.chatId,
            agentId: input.agentId,
            ...createPreambleBoundaryBinding(input.transcriptSnapshot ? 'fork' : 'new-chat'),
            nativeSession: null,
            projectPath: input.projectPath,
            tags: input.tags,
            agentSessionId: null,
            model: input.model,
            apiProviderId: input.apiProviderId,
            modelEndpointId: input.modelEndpointId,
            modelProtocol: input.modelProtocol,
            permissionMode: input.permissionMode,
            thinkingMode: input.thinkingMode,
            agentSettingsById: { [input.agentId]: input.agentSettings },
            preambleSelection: input.preambleSelection,
            parentChat: input.parentChatId === null
              ? null
              : { chatId: input.parentChatId, relation: 'delegation' },
          });
          if (!registered) throw new CommandValidationError('CHAT_ID_COLLISION', 'Start target already exists', 409);
          if (input.title !== null) {
            titleOwned = true;
            await this.deps.settings.setSessionName(input.chatId, input.title);
          }
          await this.deps.settings.ensureInNormal(input.chatId);
          await this.deps.chats.flush();
          signal?.throwIfAborted();
        },
        compensate: async () => {
          if (registered) {
            this.deps.chats.removeChat(input.chatId, 'start-compensation');
            await this.deps.chats.flush();
          }
          if (seedOwned) this.deps.transcripts.deleteChat(input.chatId);
          if (titleOwned) await this.deps.settings.removeSessionName(input.chatId);
          if (registered) try {
            await this.deps.settings.removeFromAllOrderLists(input.chatId);
          } catch (cleanupError: unknown) {
            logger.warn(
              `sessions: failed to remove ${input.chatId} from order lists after startup failure:`,
              (cleanupError as Error).message,
            );
          }
          compensated = true;
        },
      },
      dispatch: (executionAdmission) =>
        this.deps.agents.startSession(input.chatId, input.command, {
          projectPath: input.projectPath,
          images: input.images.length > 0 ? input.images : undefined,
          clientRequestId: input.clientRequestId,
          clientMessageId: input.clientMessageId,
          turnId,
          executionAdmission,
          agentSettings: input.agentSettings,
        }),
    }).catch((error: unknown) => {
      if (input.origin === 'agent-command' && compensated) throw new AgentStartCompensatedError(error);
      throw error;
    });

    if (!this.deps.metadata.getChatMetadata(input.chatId)) this.deps.metadata.addNewChatMetadata(input.chatId, input.command);

    if (recordsStartupPreferences(input.origin)) {
      try {
        await this.deps.settings.recordChatStartup(input);
      } catch (error: unknown) {
        logger.warn('commands: failed to record startup preferences:', error);
      }
    }

    if (input.title === null) void maybeGenerateChatTitle({
      chatId: input.chatId,
      projectPath: input.projectPath,
      firstPrompt: input.command,
      agents: this.deps.agents,
      settings: this.deps.settings,
      recentTitleIcons: this.deps.recentTitleIcons,
    });
    const accepted = await this.deps.ledger.updateUnlessStatus(ledger.record.key, ['failed', 'finished'], {
      status: 'running',
      turnId,
    });
    const chat = await this.support.projectCommandChat(input.chatId);
    return {
      ...agentTurnResultFromRecord(accepted ?? ledger.record),
      chat,
    };
  }

  private async replayStart(
    input: ChatStartInput,
    chatId: NormalizedChatStart['chatId'],
  ): Promise<StartChatCommandResponse | null> {
    const existing = await this.deps.ledger.getRecord(
      commandLedgerKey('chat-start', chatId, input.clientRequestId),
    );
    if (!existing) return null;
    if (existing.payloadHash !== commandPayloadHash(startReplayPayload(input, chatId))) {
      throw new CommandValidationError(
        'IDEMPOTENCY_CONFLICT',
        'clientRequestId was reused with different payload',
        409,
      );
    }
    if (
      existing.status === 'failed'
      && existing.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE
      && existing.publicTerminalAt === undefined
    ) {
      return null;
    }
    if (existing.publicTerminalAt === undefined) {
      this.support.throwRecordedExecutionFailure(existing);
    }
    return this.replayedStart(existing);
  }

  private async replayedStart(record: CommandLedgerRecord): Promise<StartChatCommandResponse> {
    return {
      ...agentTurnResultFromRecord(record, 'duplicate'),
      chat: await this.support.projectReplayedStartChat(record.chatId),
    };
  }

}

function startPayload(input: NormalizedChatStart): Record<string, unknown> {
  return {
    title: input.title,
    transcriptSnapshot: input.transcriptSnapshot,
    origin: input.origin,
    chatId: input.chatId,
    parentChatId: input.parentChatId,
    clientMessageId: input.clientMessageId,
    agentId: input.agentId,
    projectPath: input.idempotencyProjectPath,
    command: input.command,
    model: input.model,
    images: input.images,
    apiProviderId: input.apiProviderId,
    modelEndpointId: input.modelEndpointId,
    modelProtocol: input.modelProtocol,
    permissionMode: input.permissionMode,
    thinkingMode: input.thinkingMode,
    agentSettings: input.agentSettings,
    tags: input.tags,
    // Only the canonical request intent is fingerprinted, so a catalog change
    // does not turn an identical retry into an idempotency conflict.
    orderedPreambleIds: input.orderedPreambleIds ?? null,
    userMessagePresentation: input.userMessagePresentation ?? null,
  };
}

function startReplayPayload(
  input: ChatStartInput,
  chatId: NormalizedChatStart['chatId'],
): Record<string, unknown> {
  return {
    title: input.origin === 'agent-command' ? parseChatRowTitle(input.title) ?? null : null,
    transcriptSnapshot: input.origin === 'agent-command' ? input.transcriptSnapshot ?? null : null,
    origin: input.origin,
    chatId,
    parentChatId: input.parentChatId ?? null,
    clientMessageId: input.clientMessageId,
    agentId: input.agentId,
    projectPath: String(input.projectPath || '').trim(),
    command: input.command,
    model: input.model,
    images: input.images ?? [],
    apiProviderId: input.apiProviderId ?? null,
    modelEndpointId: input.modelEndpointId ?? null,
    modelProtocol: input.modelProtocol ?? null,
    permissionMode: input.permissionMode,
    thinkingMode: input.thinkingMode,
    agentSettings: input.agentSettings,
    tags: input.tags ?? [],
    orderedPreambleIds: input.orderedPreambleIds ?? null,
    userMessagePresentation: input.userMessagePresentation ?? null,
  };
}
