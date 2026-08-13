import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentChatReference, AgentChatReferenceV4 } from '@garcon/server-agent-interface';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import type { TranscriptWatermark } from '../ledger/contracts.js';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import type { IntegrationRegistry } from '../agents/integration-registry.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import { isJournalV5 } from './agent-ownership-journal-format.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createLogger } from '../lib/log.js';
import { DomainError } from '../lib/domain-error.js';
import type {
  ChatRegistryEntry,
  ChatRegistryResolvedEntry,
  IChatRegistry,
} from './store.js';
import { carryOverRevision } from './carryover-segments.js';

const logger = createLogger('chats:ownership-journal');
export const AGENT_OWNERSHIP_JOURNAL_VERSION = 5 as const;
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;

export interface AgentHandoffIntent {
  readonly version: 5;
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly submittedTargetHash: string;
  readonly kind: 'handoff';
  readonly chatId: string;
  readonly phase: 'commit-decided' | 'registry-committed';
  readonly source: {
    readonly agentId: string;
    readonly agentOwnershipEpoch: string;
  };
  readonly target: {
    readonly execution: ResolvedAgentHandoffTarget;
    readonly agentOwnershipEpoch: string;
  };
  readonly watermark: TranscriptWatermark;
  readonly createdAt: string;
}

export interface DeleteIntentV2 {
  readonly version: 2;
  readonly operationId: string;
  readonly kind: 'delete';
  readonly chatId: string;
  readonly phase: 'prepared' | 'registry-removed';
  readonly sourceEpoch: string | null;
  readonly releaseReferences: readonly AgentChatReference[];
  readonly createdAt: string;
}

export interface AgentOwnershipJournalFileV5 {
  readonly version: typeof AGENT_OWNERSHIP_JOURNAL_VERSION;
  readonly ownershipIntents: readonly (AgentHandoffIntent | DeleteIntentV2)[];
}

export function emptyOwnershipJournalV5(): AgentOwnershipJournalFileV5 {
  return { version: AGENT_OWNERSHIP_JOURNAL_VERSION, ownershipIntents: [] };
}

export class AgentOwnershipJournal {
  readonly #filePath: string;
  readonly #registry: IChatRegistry;
  readonly #integrations: IntegrationRegistry;
  readonly #releaseTimeoutMs: number;
  #journal: AgentOwnershipJournalFileV5 = emptyOwnershipJournalV5();
  #cleanupPromise: Promise<void> = Promise.resolve();
  #mutationPromise: Promise<void> = Promise.resolve();

  constructor(options: {
    workspaceDir: string;
    registry: IChatRegistry;
    integrations: IntegrationRegistry;
    releaseTimeoutMs?: number;
  }) {
    this.#filePath = path.join(options.workspaceDir, 'agent-ownership-journal.json');
    this.#registry = options.registry;
    this.#integrations = options.integrations;
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#releaseTimeoutMs) || this.#releaseTimeoutMs < 1) {
      throw new Error('Ownership cleanup release timeout must be a positive integer');
    }
  }

  async initialize(): Promise<void> {
    this.#journal = await this.#load();
    for (const intent of [...this.#journal.ownershipIntents]) {
      if (intent.kind !== 'delete') continue;
      try {
        await this.#recoverDelete(intent);
      } catch (error) {
        logger.warn('Ownership recovery retained an inconsistent delete intent', {
          chatId: intent.chatId,
          operationId: intent.operationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  hasPending(chatId: string): boolean {
    return this.#journal.ownershipIntents.some((intent) => intent.chatId === chatId);
  }

  roots(): ReadonlySet<string> {
    return new Set();
  }

  pendingHandoffs(): readonly AgentHandoffIntent[] {
    return this.#journal.ownershipIntents.filter(
      (intent): intent is AgentHandoffIntent => intent.kind === 'handoff',
    );
  }

  findHandoff(chatId: string, clientRequestId: string): AgentHandoffIntent | null {
    return this.#journal.ownershipIntents.find((intent): intent is AgentHandoffIntent => (
      intent.kind === 'handoff'
      && intent.chatId === chatId
      && intent.clientRequestId === clientRequestId
    )) ?? null;
  }

  async decideHandoff(options: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly submittedTargetHash: string;
    readonly chatId: string;
    readonly source: Pick<ChatRegistryEntry, 'agentId' | 'agentOwnershipEpoch'>;
    readonly target: ResolvedAgentHandoffTarget;
    readonly targetAgentOwnershipEpoch: string;
    readonly watermark: TranscriptWatermark;
  }): Promise<AgentHandoffIntent> {
    const intent: AgentHandoffIntent = {
      version: 5,
      operationId: options.operationId,
      clientRequestId: options.clientRequestId,
      submittedTargetHash: options.submittedTargetHash,
      kind: 'handoff',
      chatId: options.chatId,
      phase: 'commit-decided',
      source: {
        agentId: options.source.agentId,
        agentOwnershipEpoch: options.source.agentOwnershipEpoch,
      },
      target: {
        execution: structuredClone(options.target),
        agentOwnershipEpoch: options.targetAgentOwnershipEpoch,
      },
      watermark: structuredClone(options.watermark),
      createdAt: new Date().toISOString(),
    };
    await this.#mutate((current) => {
      const existing = current.ownershipIntents.find(
        (candidate) => candidate.operationId === options.operationId,
      );
      if (existing) {
        if (existing.kind === 'handoff' && sameHandoffDecision(existing, intent)) {
          return { journal: current, result: existing };
        }
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          'The handoff operation was decided with different inputs.',
          409,
        );
      }
      assertAvailable(current, options.chatId);
      return {
        journal: {
          ...current,
          ownershipIntents: [...current.ownershipIntents, intent],
        },
        result: intent,
      };
    });
    return this.#requireHandoff(options.operationId);
  }

  async applyHandoffDecision(operationId: string): Promise<ChatRegistryResolvedEntry> {
    let intent = this.#requireHandoff(operationId);
    const current = this.#registry.getChat(intent.chatId);
    if (current && matchesHandoffTarget(current, intent)) {
      return { id: intent.chatId, ...current };
    }
    if (!current || !matchesHandoffSource(current, intent)) {
      throw new DomainError(
        'STALE_CHAT_OWNERSHIP',
        `Agent handoff ownership changed for ${intent.chatId}.`,
        409,
      );
    }
    const execution = intent.target.execution;
    const updated = await this.#registry.updateChat(intent.chatId, {
      agentId: execution.agentId,
      model: execution.model,
      apiProviderId: execution.apiProviderId,
      modelEndpointId: execution.modelEndpointId,
      modelProtocol: execution.modelProtocol,
      permissionMode: execution.permissionMode,
      thinkingMode: execution.thinkingMode,
      agentSettingsById: {
        ...current.agentSettingsById,
        [execution.agentId]: execution.agentSettings,
      },
      agentSessionId: null,
      nativeSession: null,
      nativeSeedReceipt: null,
      carryOverSegments: [],
      carryOverMigrationQuarantine: null,
      agentOwnershipEpoch: intent.target.agentOwnershipEpoch,
    }, { flush: true });
    if (!updated) throw new Error(`Session not found: ${intent.chatId}`);

    if (intent.phase !== 'registry-committed') {
      intent = { ...intent, phase: 'registry-committed' };
      await this.#replaceIntent(intent);
    }
    return updated;
  }

  async completeHandoff(operationId: string): Promise<void> {
    const intent = this.#requireHandoff(operationId);
    if (!matchesHandoffTarget(this.#registry.getChat(intent.chatId), intent)) {
      throw new Error(`Cannot complete handoff before target ownership is installed: ${operationId}`);
    }
    await this.#removeIntent(operationId);
  }

  delete(chatId: string): Promise<void> {
    return this.#scheduleCleanupWork(() => this.#deleteNow(chatId));
  }

  async #deleteNow(chatId: string): Promise<void> {
    const current = this.#registry.getChat(chatId);
    const intent = await this.#mutate((journal) => {
      assertAvailable(journal, chatId, 'SESSION_BUSY');
      if (!current) return { journal, result: null };
      const reference = toAgentChatReference(
        this.#integrations.require(current.agentId),
        chatId,
        current,
        carryOverRevision(current.carryOverSegments, current.carryOverMigrationQuarantine),
      );
      const prepared: DeleteIntentV2 = {
        version: 2,
        operationId: crypto.randomUUID(),
        kind: 'delete',
        chatId,
        phase: 'prepared',
        sourceEpoch: current.agentOwnershipEpoch,
        releaseReferences: [reference],
        createdAt: new Date().toISOString(),
      };
      return {
        journal: {
          ...journal,
          ownershipIntents: [...journal.ownershipIntents, prepared],
        },
        result: prepared,
      };
    });
    if (!intent) return;
    this.#registry.removeChat(chatId);
    await this.#registry.flush();
    const removed = { ...intent, phase: 'registry-removed' as const };
    await this.#replaceIntent(removed);
    await this.#finishDelete(removed);
  }

  // V4 transfer-release maintenance has no V5 records. These methods remain
  // until the legacy repair route is deleted with the projection surface.
  abandonedTransferCleanups(): readonly never[] {
    return [];
  }

  async retryRetainedTransferCleanups(): Promise<{
    readonly retried: readonly never[];
    readonly unresolved: readonly never[];
  }> {
    return { retried: [], unresolved: [] };
  }

  async #recoverDelete(intent: DeleteIntentV2): Promise<void> {
    const current = this.#registry.getChat(intent.chatId);
    if (current) {
      if (intent.sourceEpoch !== current.agentOwnershipEpoch) {
        throw new Error(`Agent delete journal integrity failure for chat ${intent.chatId}`);
      }
      this.#registry.removeChat(intent.chatId);
      await this.#registry.flush();
    }
    const removed = { ...intent, phase: 'registry-removed' as const };
    await this.#replaceIntent(removed);
    void this.#scheduleCleanupWork(() => this.#finishDelete(removed)).catch((error) => {
      logger.warn('Recovered delete cleanup failed', {
        chatId: intent.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #finishDelete(intent: DeleteIntentV2): Promise<void> {
    let remaining = [...intent.releaseReferences];
    for (const reference of [...remaining]) {
      const integration = this.#integrations.get(reference.agentId);
      if (!integration) continue;
      try {
        await this.#releaseTranscript(integration, {
          chat: reference,
          reason: 'deleted',
        });
      } catch (error) {
        logger.warn('Delete cleanup release failed', {
          chatId: intent.chatId,
          agentId: reference.agentId,
          errorCode: errorCode(error),
        });
        continue;
      }
      remaining = remaining.filter((candidate) => candidate !== reference);
      if (remaining.length > 0) {
        await this.#replaceIntent({ ...intent, releaseReferences: remaining });
      }
    }
    if (remaining.length === 0) await this.#removeIntent(intent.operationId);
  }

  #requireHandoff(operationId: string): AgentHandoffIntent {
    const intent = this.#journal.ownershipIntents.find((candidate): candidate is AgentHandoffIntent => (
      candidate.kind === 'handoff' && candidate.operationId === operationId
    ));
    if (!intent) throw new Error(`Agent handoff intent not found: ${operationId}`);
    return intent;
  }

  async #replaceIntent(intent: AgentHandoffIntent | DeleteIntentV2): Promise<void> {
    await this.#mutate((current) => ({
      ...current,
      ownershipIntents: current.ownershipIntents.map((candidate) => (
        candidate.operationId === intent.operationId ? intent : candidate
      )),
    }));
  }

  async #removeIntent(operationId: string): Promise<void> {
    await this.#mutate((current) => ({
      ...current,
      ownershipIntents: current.ownershipIntents.filter(
        (intent) => intent.operationId !== operationId,
      ),
    }));
  }

  #scheduleCleanupWork<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#cleanupPromise.catch(() => undefined).then(work);
    this.#cleanupPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #releaseTranscript(
    integration: ReturnType<IntegrationRegistry['require']>,
    request: { readonly chat: AgentChatReference; readonly reason: 'deleted' },
  ): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        const error = new Error('Provider transcript release timed out');
        error.name = 'AbortError';
        reject(error);
      }, this.#releaseTimeoutMs);
    });
    try {
      await Promise.race([
        integration.transcript.release({
          ...request,
          chat: releaseReference(request.chat),
          signal: controller.signal,
        }),
        deadline,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #mutate<T>(
    mutation: (current: AgentOwnershipJournalFileV5) =>
      | AgentOwnershipJournalFileV5
      | { journal: AgentOwnershipJournalFileV5; result: T },
  ): Promise<T> {
    const operation = this.#mutationPromise.catch(() => undefined).then(async () => {
      const outcome = mutation(this.#journal);
      const journal = 'journal' in outcome ? outcome.journal : outcome;
      const result = 'journal' in outcome ? outcome.result : undefined as T;
      if (journal !== this.#journal) {
        await writeJsonFileAtomic(this.#filePath, journal, { mode: 0o600 });
        this.#journal = journal;
      }
      return result;
    });
    this.#mutationPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #load(): Promise<AgentOwnershipJournalFileV5> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.#filePath, 'utf8'));
      if (!isJournalV5(value)) throw new Error('Invalid agent ownership journal');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyOwnershipJournalV5();
      throw error;
    }
  }
}

function sameHandoffDecision(left: AgentHandoffIntent, right: AgentHandoffIntent): boolean {
  return left.clientRequestId === right.clientRequestId
    && left.submittedTargetHash === right.submittedTargetHash
    && left.chatId === right.chatId
    && left.source.agentId === right.source.agentId
    && left.source.agentOwnershipEpoch === right.source.agentOwnershipEpoch
    && left.target.agentOwnershipEpoch === right.target.agentOwnershipEpoch
    && JSON.stringify(left.target.execution) === JSON.stringify(right.target.execution)
    && left.watermark.viewId === right.watermark.viewId
    && left.watermark.ordinal === right.watermark.ordinal;
}

function matchesHandoffSource(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current?.agentId === intent.source.agentId
    && current.agentOwnershipEpoch === intent.source.agentOwnershipEpoch;
}

function matchesHandoffTarget(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current?.agentId === intent.target.execution.agentId
    && current.agentOwnershipEpoch === intent.target.agentOwnershipEpoch;
}

function assertAvailable(
  journal: AgentOwnershipJournalFileV5,
  chatId: string,
  code: 'AGENT_HANDOFF_REQUIRES_IDLE' | 'SESSION_BUSY' = 'AGENT_HANDOFF_REQUIRES_IDLE',
): void {
  if (!journal.ownershipIntents.some((intent) => intent.chatId === chatId)) return;
  throw new DomainError(code, `Agent ownership change is pending for ${chatId}.`, 409, true);
}

function releaseReference(reference: AgentChatReference): AgentChatReferenceV4 {
  if ('agentOwnershipEpoch' in reference
      && typeof reference.agentOwnershipEpoch === 'string'
      && reference.agentOwnershipEpoch.length > 0) {
    return reference as AgentChatReferenceV4;
  }
  return {
    ...reference,
    agentOwnershipEpoch: agentOwnershipEpoch(`legacy-release:${reference.chatId}`),
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}
