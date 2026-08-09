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
import { commandLedgerKey, PRE_SCHEDULE_FAILURE_ERROR_CODE } from './command-ledger.js';
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
    // A recorded terminal failure is re-raised with its real cause, and a
    // pre-schedule failure is retried, matching ForkCommands. Without this a
    // same-id retry falls into the duplicate branch and then fails projecting a
    // target that compensation already removed, surfacing a misleading 500 and
    // permanently poisoning that clientRequestId.
    const priorRecord = await this.deps.ledger.getRecord(
      commandLedgerKey('fork-run', input.chatId, clientRequestId),
    );
    const retryingPreScheduleFailure = priorRecord?.status === 'failed'
      && priorRecord.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE;
    if (priorRecord && priorRecord.status !== 'accepted' && !retryingPreScheduleFailure) {
      this.support.throwRecordedExecutionFailure(priorRecord);
    }
    // `scheduleAcceptedHttpRun` owns conflict and duplicate handling, so accepting
    // the ledger entry is all this command needs to do with it. Images belong in
    // the payload because they change the dispatched turn; omitting them would
    // classify a materially different request as a duplicate.
    const ledger = await this.deps.ledger.accept({
      commandType: 'fork-run',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        sourceChatId: input.sourceChatId,
        chatId: input.chatId,
        command: input.command,
        clientMessageId,
        ...(input.images === undefined ? {} : { images: input.images }),
      },
      turnId,
    });
    // An existing target is only acceptable when a ledger record proves this
    // operation created it. Provenance is the record existing at all, not its
    // status: a lost-202 retry legitimately finds its own target already
    // scheduled or finished. Without the check, a fresh request would submit its
    // prompt into an unrelated chat and report that as the continuation.
    const targetExists = this.deps.chats.getChat(input.chatId) !== null;
    if (targetExists && !priorRecord) {
      throw new CommandValidationError(
        'IDEMPOTENCY_CONFLICT',
        `Session already exists: ${input.chatId}`,
        409,
      );
    }

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
            // Undoes the list placement and name as well as the registry entry.
            // Leaving those behind would strand a named, ordered chat that no
            // longer exists, which is what `rollbackForkTarget` avoids.
            await this.deps.chats.removeChat(input.chatId);
            await this.deps.settings.removeFromAllOrderLists(input.chatId);
            await this.deps.settings.removeSessionName(input.chatId);
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
      // Without this the continuation lands as an orphan in the chat list with
      // no name, unlike every other chat-creating path.
      await this.deps.settings.ensureInNormal(input.chatId);
      const sourceMeta = this.deps.metadata.getChatMetadata(input.sourceChatId);
      if (sourceMeta?.firstMessage) {
        this.deps.metadata.addNewChatMetadata(input.chatId, sourceMeta.firstMessage);
      }
      const sourceName = this.deps.settings.getChatName(input.sourceChatId);
      if (sourceName) await this.deps.settings.setSessionName(input.chatId, sourceName);
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
    // Any executing source is refused, not just a materializing one. Settled
    // capture only proves the transcript held still for a moment, so a long tool
    // call can look stable and then append the rest of its turn afterwards —
    // work the continuation could never read. Provider-native fork can copy a
    // live session; this has no such contract.
    if (this.deps.queue.ownsExecution(sourceChatId)) {
      throw new CommandValidationError(
        'SESSION_BUSY',
        'Cannot hand off a chat while it is running',
        409,
        true,
      );
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
