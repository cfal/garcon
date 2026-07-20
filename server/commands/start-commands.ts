import crypto from 'crypto';
import { promises as fs } from 'fs';
import { parseAgentSettingsEnvelope } from '../../common/agent-integration.js';
import type { StartChatCommandResponse } from '../../common/chat-command-contracts.js';
import { normalizePermissionMode, normalizeThinkingMode } from '../../common/chat-modes.js';
import { normalizeTags } from '../../common/tags.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.js';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import { createLogger } from '../lib/log.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import {
  CommandSupport,
  CommandValidationError,
  commandResultFromRecord,
  type ChatStartInput,
  type NormalizedChatStart,
  type ScheduledChatStartInput,
} from './command-support.js';

const logger = createLogger('commands:start');

export class StartCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async submitStart(input: ChatStartInput): Promise<StartChatCommandResponse> {
    const normalized = await this.normalizeStart(input);
    return this.support.withChatMutationLock(
      normalized.chatId,
      () => this.submitNormalizedStart(normalized),
    );
  }

  async submitScheduledStart(input: ScheduledChatStartInput): Promise<StartChatCommandResponse> {
    const normalized = await this.normalizeStart({
      ...input,
      chatId: this.deps.chatIds.allocate(),
      images: [],
    });
    return this.support.withChatMutationLock(
      normalized.chatId,
      () => this.submitNormalizedStart(normalized),
    );
  }

  private async normalizeStart(input: ChatStartInput): Promise<NormalizedChatStart> {
    const chatId = this.support.requireChatId(input.chatId);
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.support.requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const agentId = input.agentId.trim();
    const command = input.command.trim();
    const model = input.model.trim();
    const images = this.support.validateAttachments(input.images) ?? [];

    if (!agentId) throw new CommandValidationError('VALIDATION_FAILED', 'agentId is required');
    if (!this.deps.agents.hasAgent(agentId)) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Unsupported agent: ${agentId}`);
    }
    if (!model) throw new CommandValidationError('VALIDATION_FAILED', 'model is required');
    if (!command && images.length === 0) {
      throw new CommandValidationError('VALIDATION_FAILED', 'command or attachments are required');
    }
    await this.assertStartImagesSupported({
      agentId,
      model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
      images,
    });

    const directSettings = parseAgentSettingsEnvelope(input.agentSettings);
    const settingsById = input.agentSettingsById && typeof input.agentSettingsById === 'object'
      ? input.agentSettingsById as Record<string, unknown>
      : null;
    const scheduledSettings = parseAgentSettingsEnvelope(settingsById?.[agentId]);
    const agentSettings = directSettings ?? scheduledSettings;
    if (!agentSettings || agentSettings.ownerId !== agentId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'agentSettings must be owned by agentId');
    }

    return {
      chatId,
      clientRequestId,
      clientMessageId,
      agentId,
      projectPath: await this.resolveProjectPathForStart(input.projectPath.trim()),
      command,
      images,
      model,
      apiProviderId: input.apiProviderId ?? null,
      modelEndpointId: input.modelEndpointId ?? null,
      modelProtocol: input.modelProtocol ?? null,
      permissionMode: normalizePermissionMode(input.permissionMode),
      thinkingMode: normalizeThinkingMode(input.thinkingMode),
      agentSettings,
      tags: normalizeTags(Array.isArray(input.tags) ? input.tags : []),
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
      payload: {
        chatId: input.chatId,
        clientMessageId: input.clientMessageId,
        agentId: input.agentId,
        projectPath: input.projectPath,
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
      },
    });
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') this.support.throwRecordedExecutionFailure(ledger.record);
    if (ledger.kind === 'duplicate') {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
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
          this.deps.chats.removeChat(input.chatId);
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
    });
    const accepted = await this.deps.ledger.updateUnlessStatus(ledger.record.key, ['failed', 'finished'], {
      status: 'running',
      turnId,
    });
    return {
      ...commandResultFromRecord(accepted ?? ledger.record),
      chat: await this.support.projectCommandChat(input.chatId),
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
