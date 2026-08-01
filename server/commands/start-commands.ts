import crypto from 'crypto';
import { promises as fs } from 'fs';
import type { StartChatCommandResponse } from '../../common/chat-command-contracts.js';
import type { RunAgentTurnOptions } from '../agents/session-types.js';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import { createLogger } from '../lib/log.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import {
  CommandSupport,
  CommandValidationError,
  agentTurnResultFromRecord,
  type ChatStartInput,
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
      async () => {
        const replay = await this.replayStart(input, chatId);
        if (replay) return replay;
        return this.submitNormalizedStart(await this.normalizeStart(input, chatId));
      },
    );
  }

  async submitScheduledStart(input: ScheduledChatStartInput): Promise<StartChatCommandResponse> {
    return this.submitStart({
      ...input,
      chatId: this.deps.chatIds.allocate(),
      images: [],
      agentSettings: input.agentSettingsById[input.agentId],
    });
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
    this.support.assertContent(input.command, images);
    await this.assertStartImagesSupported({
      agentId: input.agentId,
      model: input.model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
      images,
    });

    if (!input.agentSettings || input.agentSettings.ownerId !== input.agentId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'agentSettings must be owned by agentId');
    }

    return {
      chatId,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      agentId: input.agentId,
      projectPath: await this.resolveProjectPathForStart(input.projectPath),
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
    };
  }

  private async assertStartImagesSupported(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
    images: NonNullable<RunAgentTurnOptions['images']>;
  }): Promise<void> {
    if (input.images.length === 0) return;

    let modelSupportsImages = false;
    try {
      modelSupportsImages = await this.deps.agents.modelSupportsImages({
        agentId: input.agentId,
        model: input.model,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
      });
    } catch {}
    const hasBackendSelection = Boolean(input.apiProviderId && input.modelEndpointId);
    const supportsImages = hasBackendSelection ? modelSupportsImages : this.deps.agents.supportsImages(input.agentId);
    if (!supportsImages) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Attachments unsupported for agent: ${input.agentId}`, 422);
    }
  }

  private async submitNormalizedStart(input: NormalizedChatStart): Promise<StartChatCommandResponse> {
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
      return {
        ...agentTurnResultFromRecord(ledger.record, 'duplicate'),
        chat: await this.support.projectCommandChat(ledger.record.chatId),
      };
    }

    const existing = this.deps.chats.getChat(input.chatId);
    if (existing) {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', `Session already exists: ${input.chatId}`, 409);
    }

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
      settlement: this.support.settlement,
      preparation: {
        operation: 'chat-start',
        prepare: async () => {
          this.deps.chats.addChat({
            id: input.chatId,
            agentId: input.agentId,
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
          });
          this.deps.metadata.addNewChatMetadata(input.chatId, input.command);
          await this.deps.settings.recordChatStartup({
            agentId: input.agentId,
            projectPath: input.projectPath,
            model: input.model,
            apiProviderId: input.apiProviderId,
            modelEndpointId: input.modelEndpointId,
            modelProtocol: input.modelProtocol,
            permissionMode: input.permissionMode,
            thinkingMode: input.thinkingMode,
            agentSettingsById: { [input.agentId]: input.agentSettings },
          });
          await this.deps.settings.ensureInNormal(input.chatId);
        },
        compensate: async () => {
          this.deps.pendingInputs.clearChat(input.chatId, 'chat-removed');
          this.deps.chats.removeChat(input.chatId, 'start-compensation');
          try {
            await this.deps.settings.removeFromAllOrderLists(input.chatId);
          } catch (cleanupError: unknown) {
            logger.warn(
              `sessions: failed to remove ${input.chatId} from order lists after startup failure:`,
              (cleanupError as Error).message,
            );
          }
        },
      },
      dispatch: (executionAdmission) => this.deps.agents.startSession(input.chatId, input.command, {
        projectPath: input.projectPath,
        images: input.images.length > 0 ? input.images : undefined,
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        turnId,
        executionAdmission,
        agentSettings: input.agentSettings,
      }),
    });

    void maybeGenerateChatTitle({
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
    return {
      ...agentTurnResultFromRecord(accepted ?? ledger.record),
      chat: await this.support.projectCommandChat(input.chatId),
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
    ) {
      return null;
    }
    return this.replayedStart(existing);
  }

  private async replayedStart(record: CommandLedgerRecord): Promise<StartChatCommandResponse> {
    return {
      ...agentTurnResultFromRecord(record, 'duplicate'),
      chat: await this.support.projectCommandChat(record.chatId),
    };
  }

  private async resolveProjectPathForStart(projectPath: string | undefined): Promise<string> {
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

    try {
      await fs.access(resolvedPath);
    } catch {
      throw new CommandValidationError('VALIDATION_FAILED', `Project path not found: ${resolvedPath}`, 404);
    }

    return resolvedPath;
  }
}

function startPayload(input: NormalizedChatStart): Record<string, unknown> {
  return {
    chatId: input.chatId,
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
  };
}

function startReplayPayload(
  input: ChatStartInput,
  chatId: NormalizedChatStart['chatId'],
): Record<string, unknown> {
  return {
    chatId,
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
  };
}
