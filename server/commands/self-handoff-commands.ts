// `/handoff` continues a chat under the same agent in a new chat. The source
// keeps its provider session untouched; the target starts a fresh one seeded
// from the projected carryover transcript, compacted when that setting is on.
//
// This is the provider-agnostic sibling of `/compact`. Native compaction rewrites
// a provider's own session in place and keeps everything the transcript does not
// capture, so it stays the better option where a provider implements it; where
// one does not, this sheds context without needing provider support at all.
//
// Deliberately not built on the fork path: forking requires `supportsFork` and
// copies the provider session, and `/handoff` wants neither.
import crypto from 'crypto';
import type { ForkRunCommandResponse } from '../../common/chat-command-contracts.js';
import type { SelfHandoffRunCommandRequest } from '../../common/self-handoff-contracts.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import { createLogger } from '../lib/log.js';
import { CommandSupport, CommandValidationError } from './command-support.js';

const logger = createLogger('commands:self-handoff');

export class SelfHandoffCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async submitSelfHandoffRun(
    input: SelfHandoffRunCommandRequest,
  ): Promise<ForkRunCommandResponse> {
    this.support.assertContent(input.command, input.images);
    const sourceChatId = this.support.requireChatId(input.sourceChatId, 'sourceChatId');
    const chatId = this.support.requireChatId(input.chatId);
    if (sourceChatId === chatId) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'sourceChatId and chatId must differ',
      );
    }
    return this.support.withChatMutationLocks(
      [sourceChatId, chatId],
      () => this.#submit({ ...input, sourceChatId, chatId }),
    );
  }

  async #submit(input: SelfHandoffRunCommandRequest): Promise<ForkRunCommandResponse> {
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.support.requireClientRequestId(
      input.clientMessageId,
      'clientMessageId',
    );
    const source = this.#requireSource(input.sourceChatId);
    await this.support.assertAttachmentsSupported({
      agentId: source.agentId,
      model: source.model,
      apiProviderId: source.apiProviderId,
      modelEndpointId: source.modelEndpointId,
      attachments: input.images ?? [],
    });

    const turnId = crypto.randomUUID();
    // `scheduleAcceptedHttpRun` owns conflict and duplicate handling, so accepting
    // the ledger entry is all this command needs to do with it.
    const ledger = await this.deps.ledger.accept({
      commandType: 'fork-run',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        sourceChatId: input.sourceChatId,
        chatId: input.chatId,
        command: input.command,
        clientMessageId,
      },
      turnId,
    });
    const targetExists = this.deps.chats.getChat(input.chatId) !== null;

    let created = false;
    const result = await this.support.scheduleAcceptedHttpRun(
      ledger,
      {
        chatId: input.chatId,
        command: input.command,
        ...(input.images === undefined ? {} : { images: input.images }),
        clientRequestId,
        clientMessageId,
        // The target inherits the source's agent, model, and modes from the
        // registry entry created below, so the turn carries no overrides.
        options: {},
      },
      { clientRequestId, clientMessageId, turnId },
      'fork-run',
      {
        operation: 'fork-run',
        prepare: async (context) => {
          if (targetExists) return;
          await this.#createContinuation(input, source, context.signal);
          created = true;
        },
        compensate: async () => {
          if (!created) return;
          created = false;
          try {
            await this.deps.chats.removeChat(input.chatId);
          } catch (error) {
            logger.warn('failed to remove continuation chat after failure', {
              chatId: input.chatId,
              error,
            });
          }
        },
      },
    );
    return { ...result, chat: await this.support.projectCommandChat(input.chatId) };
  }

  // Archives the source's live era, then registers the target with the combined
  // refs and no provider session. The absent session is what makes the target
  // seed itself through `loadCarriedContext` on its first turn, which is the same
  // path an agent switch takes.
  async #createContinuation(
    input: SelfHandoffRunCommandRequest,
    source: ChatRegistryEntry,
    signal: AbortSignal,
  ): Promise<void> {
    const captured = await this.deps.handoffs.captureContinuationSegments({
      chatId: input.sourceChatId,
      source,
      target: { agentId: source.agentId, model: source.model },
      operationId: `self-handoff:${input.chatId}:${input.clientRequestId}`,
      clientRequestId: input.clientRequestId,
      signal,
    });
    try {
      await captured.assertUnchanged(signal);
      const added = this.deps.chats.addChat({
        id: input.chatId,
        agentId: source.agentId,
        model: source.model,
        apiProviderId: source.apiProviderId ?? null,
        modelEndpointId: source.modelEndpointId ?? null,
        modelProtocol: source.modelProtocol ?? null,
        projectPath: source.projectPath,
        nativeSession: null,
        agentOwnershipEpoch: crypto.randomUUID(),
        tags: [...source.tags],
        agentSessionId: null,
        nextForkOrdinal: 1,
        permissionMode: source.permissionMode,
        thinkingMode: source.thinkingMode,
        agentSettingsById: { ...source.agentSettingsById },
        carryOverSegments: captured.segments,
        nativeSeedReceipt: null,
        carryOverMigrationQuarantine: source.carryOverMigrationQuarantine,
      });
      if (!added) {
        throw new CommandValidationError(
          'IDEMPOTENCY_CONFLICT',
          `Session already exists: ${input.chatId}`,
          409,
        );
      }
      captured.prepared?.releaseRoot();
    } catch (error) {
      await captured.prepared?.discard();
      throw error;
    }
  }

  #requireSource(sourceChatId: string): ChatRegistryEntry {
    const source = this.deps.chats.getChat(sourceChatId);
    if (!source) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Source session not found', 404);
    }
    if (source.carryOverMigrationQuarantine) {
      throw new CommandValidationError(
        'TRANSCRIPT_UNAVAILABLE',
        'This chat\'s carried-over history is quarantined and cannot be continued.',
        422,
      );
    }
    return source;
  }
}
