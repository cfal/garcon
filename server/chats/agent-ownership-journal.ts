import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseAgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { isPermissionMode, isThinkingMode } from '@garcon/common/chat-modes';
import {
  parseNativeSeedReceipt,
  type NativeSeedReceipt,
} from '@garcon/common/transcript-seed';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { ResolvedAgentHandoffTarget } from '../agents/agent-handoff-types.js';
import type { IntegrationRegistry } from '../agents/integration-registry.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { createLogger } from '../lib/log.js';
import { DomainError } from '../lib/domain-error.js';
import type {
  CarryOverSegmentRef,
  ChatRegistryEntry,
  ChatRegistryResolvedEntry,
  IChatRegistry,
} from './store.js';
import { parseCarryOverSegmentRefs } from './store.js';
import { carryOverRevision } from './carryover-segments.js';

const logger = createLogger('chats:ownership-journal');
export const AGENT_OWNERSHIP_JOURNAL_VERSION = 3 as const;
const MAX_TRANSFER_RELEASE_ATTEMPTS = 3;
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;

export interface AgentHandoffIntent {
  readonly version: 3;
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly submittedTargetHash: string;
  readonly kind: 'handoff';
  readonly chatId: string;
  readonly phase: 'segment-prepared' | 'registry-committed';
  readonly source: {
    readonly agentId: string;
    readonly model: string;
    readonly sessionId: string | null;
    readonly agentOwnershipEpoch: string;
    readonly carryOverRevision: string;
    readonly nativeSeedReceipt: NativeSeedReceipt | null;
    readonly reference: AgentChatReference;
  };
  readonly target: {
    readonly execution: ResolvedAgentHandoffTarget;
    readonly agentOwnershipEpoch: string;
    readonly carryOverSegments: readonly CarryOverSegmentRef[];
  };
  readonly createdAt: string;
}

export interface SourceReleaseCleanup {
  readonly version: 1;
  readonly operationId: string;
  readonly chatId: string;
  readonly source: AgentChatReference;
  readonly reason: 'transferred';
  readonly status: 'pending' | 'claimed' | 'abandoned';
  readonly attempts: number;
  readonly lastErrorCode: string | null;
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

export interface AgentOwnershipJournalFileV3 {
  readonly version: typeof AGENT_OWNERSHIP_JOURNAL_VERSION;
  readonly ownershipIntents: readonly (AgentHandoffIntent | DeleteIntentV2)[];
  readonly transferCleanup: readonly SourceReleaseCleanup[];
}

export function emptyOwnershipJournalV3(): AgentOwnershipJournalFileV3 {
  return {
    version: AGENT_OWNERSHIP_JOURNAL_VERSION,
    ownershipIntents: [],
    transferCleanup: [],
  };
}

export class AgentOwnershipJournal {
  readonly #filePath: string;
  readonly #registry: IChatRegistry;
  readonly #integrations: IntegrationRegistry;
  readonly #releaseTimeoutMs: number;
  #journal: AgentOwnershipJournalFileV3 = emptyOwnershipJournalV3();
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
    if (this.#journal.transferCleanup.some((cleanup) => cleanup.status === 'claimed')) {
      await this.#mutate((current) => ({
        ...current,
        transferCleanup: current.transferCleanup.map((cleanup) => (
          cleanup.status === 'claimed' ? { ...cleanup, status: 'pending' as const } : cleanup
        )),
      }));
    }

    for (const intent of [...this.#journal.ownershipIntents]) {
      try {
        if (intent.kind === 'handoff') await this.#recoverHandoff(intent);
        else await this.#recoverDelete(intent);
      } catch (error) {
        logger.warn('Ownership recovery retained an inconsistent intent', {
          chatId: intent.chatId,
          operationId: intent.operationId,
          kind: intent.kind,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    void this.drainTransferCleanup().catch((error) => {
      logger.warn('Startup ownership cleanup failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  hasPending(chatId: string): boolean {
    return this.#journal.ownershipIntents.some((intent) => intent.chatId === chatId);
  }

  roots(): ReadonlySet<string> {
    const roots = new Set<string>();
    for (const intent of this.#journal.ownershipIntents) {
      if (intent.kind !== 'handoff') continue;
      for (const ref of intent.target.carryOverSegments) {
        if (ref.storedMessageCount > 0) roots.add(ref.id);
      }
    }
    return roots;
  }

  findHandoff(chatId: string, clientRequestId: string): AgentHandoffIntent | null {
    return this.#journal.ownershipIntents.find((intent): intent is AgentHandoffIntent => (
      intent.kind === 'handoff'
      && intent.chatId === chatId
      && intent.clientRequestId === clientRequestId
    )) ?? null;
  }

  async beginHandoff(options: {
    readonly operationId: string;
    readonly clientRequestId: string;
    readonly submittedTargetHash: string;
    readonly chatId: string;
    readonly source: ChatRegistryEntry;
    readonly target: ResolvedAgentHandoffTarget;
    readonly targetCarryOverSegments: readonly CarryOverSegmentRef[];
  }): Promise<AgentHandoffIntent> {
    const sourceIntegration = this.#integrations.require(options.source.agentId);
    const intent: AgentHandoffIntent = {
      version: 3,
      operationId: options.operationId,
      clientRequestId: options.clientRequestId,
      submittedTargetHash: options.submittedTargetHash,
      kind: 'handoff',
      chatId: options.chatId,
      phase: 'segment-prepared',
      source: {
        agentId: options.source.agentId,
        model: options.source.model,
        sessionId: options.source.agentSessionId,
        agentOwnershipEpoch: options.source.agentOwnershipEpoch,
        carryOverRevision: carryOverRevision(
          options.source.carryOverSegments,
          options.source.carryOverMigrationQuarantine,
        ),
        nativeSeedReceipt: options.source.nativeSeedReceipt,
        reference: toAgentChatReference(
          sourceIntegration,
          options.chatId,
          options.source,
          carryOverRevision(
            options.source.carryOverSegments,
            options.source.carryOverMigrationQuarantine,
          ),
        ),
      },
      target: {
        execution: options.target,
        agentOwnershipEpoch: crypto.randomUUID(),
        carryOverSegments: parseCarryOverSegmentRefs(options.targetCarryOverSegments),
      },
      createdAt: new Date().toISOString(),
    };
    await this.#mutate((current) => {
      assertAvailable(current, options.chatId);
      return {
        ...current,
        ownershipIntents: [...current.ownershipIntents, intent],
      };
    });
    return intent;
  }

  async commitHandoff(
    operationId: string,
    assertAdmissionActive: () => void,
  ): Promise<ChatRegistryResolvedEntry> {
    const intent = this.#requireHandoff(operationId);
    const current = this.#registry.getChat(intent.chatId);
    if (current && matchesHandoffTarget(current, intent)) {
      await this.#finishHandoff(intent);
      return { id: intent.chatId, ...current };
    }
    if (!current || !matchesHandoffSource(current, intent)) {
      throw new DomainError(
        'STALE_CHAT_OWNERSHIP',
        `Agent handoff ownership changed for ${intent.chatId}.`,
        409,
      );
    }
    assertAdmissionActive();
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
      carryOverSegments: intent.target.carryOverSegments,
      agentOwnershipEpoch: intent.target.agentOwnershipEpoch,
    }, { flush: true });
    if (!updated) throw new Error(`Session not found: ${intent.chatId}`);

    const committed = { ...intent, phase: 'registry-committed' as const };
    await this.#replaceIntent(committed);
    await this.#finishHandoff(committed);
    return updated;
  }

  async compensateHandoff(operationId: string): Promise<void> {
    const intent = this.#findHandoffByOperation(operationId);
    if (!intent) return;
    const current = this.#registry.getChat(intent.chatId);
    if (current && matchesHandoffTarget(current, intent)) {
      await this.#finishHandoff(intent);
      return;
    }
    if (current && !matchesHandoffSource(current, intent)) {
      throw new Error(`Cannot compensate handoff after ownership changed for ${intent.chatId}`);
    }
    await this.#removeIntent(intent.operationId);
  }

  delete(chatId: string): Promise<void> {
    return this.#scheduleCleanupWork(() => this.#deleteNow(chatId));
  }

  async #deleteNow(chatId: string): Promise<void> {
    const current = this.#registry.getChat(chatId);
    const intent = await this.#mutate((journal) => {
      assertAvailable(journal, chatId, 'SESSION_BUSY');
      const absorbedCleanup = journal.transferCleanup.filter((entry) => entry.chatId === chatId);
      if (!current && absorbedCleanup.length === 0) return { journal, result: null };
      const references = absorbedCleanup.map((entry) => entry.source);
      if (current) {
        references.push(toAgentChatReference(
          this.#integrations.require(current.agentId),
          chatId,
          current,
          carryOverRevision(current.carryOverSegments, current.carryOverMigrationQuarantine),
        ));
      }
      const prepared: DeleteIntentV2 = {
        version: 2,
        operationId: crypto.randomUUID(),
        kind: 'delete',
        chatId,
        phase: 'prepared',
        sourceEpoch: current?.agentOwnershipEpoch ?? null,
        releaseReferences: deduplicateReferences(references),
        createdAt: new Date().toISOString(),
      };
      return {
        journal: {
          ...journal,
          ownershipIntents: [...journal.ownershipIntents, prepared],
          transferCleanup: journal.transferCleanup.filter((entry) => entry.chatId !== chatId),
        },
        result: prepared,
      };
    });
    if (!intent) return;
    if (current) {
      this.#registry.removeChat(chatId);
      await this.#registry.flush();
    }
    const removed = { ...intent, phase: 'registry-removed' as const };
    await this.#replaceIntent(removed);
    await this.#finishDelete(removed);
  }

  drainTransferCleanup(): Promise<void> {
    return this.#scheduleCleanupWork(() => this.#drainTransferCleanupNow());
  }

  // Abandoned records are the only reference that can reclaim provider residue,
  // so they stay durable and visible to maintenance instead of being dropped.
  abandonedTransferCleanups(): readonly SourceReleaseCleanup[] {
    return this.#journal.transferCleanup.filter((cleanup) => cleanup.status === 'abandoned');
  }

  // Maintenance retry covers every retained transfer cleanup, not only
  // abandoned ones: a record an earlier maintenance call reset settles as
  // pending after a failed drain and has no drain path until the next startup
  // or handoff, so selecting only abandoned records would strand it and report
  // nothing unresolved while provider residue remains. Only abandoned records
  // get a fresh attempt budget; ordinary pending records keep their history.
  // `unresolved` reports every selected record still held after the drain,
  // whatever its status, including a missing integration, which never consumes
  // an attempt. Serialized behind the cleanup queue, so no in-flight record is
  // stolen mid-release.
  async retryRetainedTransferCleanups(): Promise<{
    readonly retried: readonly SourceReleaseCleanup[];
    readonly unresolved: readonly SourceReleaseCleanup[];
  }> {
    return this.#scheduleCleanupWork(async () => {
      const retried = this.#journal.transferCleanup.filter(
        (cleanup) => cleanup.status !== 'claimed',
      );
      if (retried.length === 0) return { retried, unresolved: [] };
      const abandoned = new Set(
        retried
          .filter((cleanup) => cleanup.status === 'abandoned')
          .map((cleanup) => cleanup.operationId),
      );
      if (abandoned.size > 0) {
        await this.#mutate((current) => ({
          ...current,
          transferCleanup: current.transferCleanup.map((cleanup) => (
            abandoned.has(cleanup.operationId)
              ? { ...cleanup, status: 'pending' as const, attempts: 0, lastErrorCode: null }
              : cleanup
          )),
        }));
      }
      await this.#drainTransferCleanupNow();
      const selected = new Set(retried.map((cleanup) => cleanup.operationId));
      const unresolved = this.#journal.transferCleanup.filter(
        (cleanup) => selected.has(cleanup.operationId),
      );
      return { retried, unresolved };
    });
  }

  async #recoverHandoff(intent: AgentHandoffIntent): Promise<void> {
    const current = this.#registry.getChat(intent.chatId);
    if (current && matchesHandoffSource(current, intent)) {
      if (intent.phase === 'registry-committed') {
        throw new Error(`Committed handoff reverted to its source for ${intent.chatId}`);
      }
      await this.#removeIntent(intent.operationId);
      return;
    }
    if (current && matchesHandoffTarget(current, intent)) {
      await this.#finishHandoff(intent);
      return;
    }
    logger.warn('Discarding a superseded handoff intent', {
      chatId: intent.chatId,
      operationId: intent.operationId,
    });
    await this.#removeIntent(intent.operationId);
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

  async #finishHandoff(intent: AgentHandoffIntent): Promise<void> {
    const cleanup: SourceReleaseCleanup = {
      version: 1,
      operationId: intent.operationId,
      chatId: intent.chatId,
      source: intent.source.reference,
      reason: 'transferred',
      status: 'pending',
      attempts: 0,
      lastErrorCode: null,
      createdAt: intent.createdAt,
    };
    await this.#mutate((current) => ({
      ...current,
      ownershipIntents: current.ownershipIntents.filter(
        (candidate) => candidate.operationId !== intent.operationId,
      ),
      transferCleanup: current.transferCleanup.some(
        (candidate) => candidate.operationId === intent.operationId,
      )
        ? current.transferCleanup
        : [...current.transferCleanup, cleanup],
    }));
    void this.drainTransferCleanup().catch((error) => {
      logger.warn('Transfer cleanup drain failed', {
        chatId: intent.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #finishDelete(intent: DeleteIntentV2): Promise<void> {
    let remaining = [...intent.releaseReferences];
    for (const reference of [...remaining]) {
      const integration = this.#integrations.get(reference.agentId);
      if (!integration) {
        logger.warn('Delete cleanup integration is unavailable', {
          chatId: intent.chatId,
          agentId: reference.agentId,
        });
        continue;
      }
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

  async #drainTransferCleanupNow(): Promise<void> {
    for (const operationId of this.#journal.transferCleanup.map((entry) => entry.operationId)) {
      const cleanup = await this.#mutate((current) => {
        const candidate = current.transferCleanup.find((entry) => entry.operationId === operationId);
        if (!candidate || candidate.status !== 'pending') return { journal: current, result: null };
        const claimed = { ...candidate, status: 'claimed' as const };
        return {
          journal: replaceCleanup(current, claimed),
          result: claimed,
        };
      });
      if (!cleanup) continue;
      const integration = this.#integrations.get(cleanup.source.agentId);
      if (!integration) {
        await this.#replaceCleanup({ ...cleanup, status: 'pending' });
        continue;
      }
      try {
        await this.#releaseTranscript(integration, {
          chat: cleanup.source,
          reason: 'transferred',
        });
        await this.#removeCleanup(cleanup.operationId);
      } catch (error) {
        const attempts = cleanup.attempts + 1;
        const failed: SourceReleaseCleanup = {
          ...cleanup,
          status: attempts >= MAX_TRANSFER_RELEASE_ATTEMPTS ? 'abandoned' : 'pending',
          attempts,
          lastErrorCode: errorCode(error),
        };
        await this.#replaceCleanup(failed);
        logger.warn('Source transcript release failed', {
          chatId: cleanup.chatId,
          agentId: cleanup.source.agentId,
          attempts,
          abandoned: failed.status === 'abandoned',
          errorCode: failed.lastErrorCode,
        });
      }
    }
  }

  #requireHandoff(operationId: string): AgentHandoffIntent {
    const intent = this.#findHandoffByOperation(operationId);
    if (!intent) throw new Error(`Agent handoff intent not found: ${operationId}`);
    return intent;
  }

  #findHandoffByOperation(operationId: string): AgentHandoffIntent | null {
    return this.#journal.ownershipIntents.find((intent): intent is AgentHandoffIntent => (
      intent.kind === 'handoff' && intent.operationId === operationId
    )) ?? null;
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

  async #replaceCleanup(cleanup: SourceReleaseCleanup): Promise<void> {
    await this.#mutate((current) => replaceCleanup(current, cleanup));
  }

  async #removeCleanup(operationId: string): Promise<void> {
    await this.#mutate((current) => ({
      ...current,
      transferCleanup: current.transferCleanup.filter(
        (cleanup) => cleanup.operationId !== operationId,
      ),
    }));
  }

  #scheduleCleanupWork<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#cleanupPromise
      .catch(() => undefined)
      .then(work);
    this.#cleanupPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #releaseTranscript(
    integration: ReturnType<IntegrationRegistry['require']>,
    request: Omit<Parameters<typeof integration.transcript.release>[0], 'signal'>,
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
        integration.transcript.release({ ...request, signal: controller.signal }),
        deadline,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #mutate<T>(
    mutation: (current: AgentOwnershipJournalFileV3) =>
      | AgentOwnershipJournalFileV3
      | { journal: AgentOwnershipJournalFileV3; result: T },
  ): Promise<T> {
    const operation = this.#mutationPromise
      .catch(() => undefined)
      .then(async () => {
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

  async #load(): Promise<AgentOwnershipJournalFileV3> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.#filePath, 'utf8'));
      if (!isJournalV3(value)) throw new Error('Invalid agent ownership journal');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyOwnershipJournalV3();
      throw error;
    }
  }
}

function matchesHandoffSource(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current?.agentId === intent.source.agentId
    && current.agentOwnershipEpoch === intent.source.agentOwnershipEpoch
    && current.agentSessionId === intent.source.sessionId
    && carryOverRevision(
      current.carryOverSegments,
      current.carryOverMigrationQuarantine,
    ) === intent.source.carryOverRevision;
}

function assertAvailable(
  journal: AgentOwnershipJournalFileV3,
  chatId: string,
  code: 'AGENT_HANDOFF_REQUIRES_IDLE' | 'SESSION_BUSY' = 'AGENT_HANDOFF_REQUIRES_IDLE',
): void {
  if (journal.ownershipIntents.some((intent) => intent.chatId === chatId)) {
    throw new DomainError(
      code,
      `Agent ownership change is pending for ${chatId}.`,
      409,
      true,
    );
  }
}

function replaceCleanup(
  journal: AgentOwnershipJournalFileV3,
  cleanup: SourceReleaseCleanup,
): AgentOwnershipJournalFileV3 {
  return {
    ...journal,
    transferCleanup: journal.transferCleanup.map((candidate) => (
      candidate.operationId === cleanup.operationId ? cleanup : candidate
    )),
  };
}

function matchesHandoffTarget(
  current: ChatRegistryEntry | null,
  intent: AgentHandoffIntent,
): boolean {
  return current?.agentId === intent.target.execution.agentId
    && current.agentOwnershipEpoch === intent.target.agentOwnershipEpoch
    && JSON.stringify(current.carryOverSegments) === JSON.stringify(intent.target.carryOverSegments);
}

function deduplicateReferences(references: readonly AgentChatReference[]): AgentChatReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = JSON.stringify(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

function isJournalV3(value: unknown): value is AgentOwnershipJournalFileV3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  if (journal.version !== AGENT_OWNERSHIP_JOURNAL_VERSION) return false;
  if (!Array.isArray(journal.ownershipIntents) || !Array.isArray(journal.transferCleanup)) return false;
  return journal.ownershipIntents.every(isOwnershipIntent)
    && journal.transferCleanup.every(isTransferCleanup);
}

function isOwnershipIntent(value: unknown): value is AgentHandoffIntent | DeleteIntentV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if ((intent.version !== 2 && intent.version !== 3) || typeof intent.operationId !== 'string' || typeof intent.chatId !== 'string') {
    return false;
  }
  if (intent.kind === 'delete') {
    return (intent.phase === 'prepared' || intent.phase === 'registry-removed')
      && (intent.sourceEpoch === null || typeof intent.sourceEpoch === 'string')
      && Array.isArray(intent.releaseReferences)
      && intent.releaseReferences.every(isAgentChatReference)
      && typeof intent.createdAt === 'string';
  }
  const source = intent.source;
  const target = intent.target;
  return intent.kind === 'handoff'
    && intent.version === 3
    && (intent.phase === 'segment-prepared' || intent.phase === 'registry-committed')
    && typeof intent.clientRequestId === 'string'
    && typeof intent.submittedTargetHash === 'string'
    && /^[a-f0-9]{64}$/.test(intent.submittedTargetHash)
    && isObject(source)
    && nonEmptyString(source.agentId)
    && typeof source.model === 'string'
    && nullableString(source.sessionId)
    && nonEmptyString(source.agentOwnershipEpoch)
    && nonEmptyString(source.carryOverRevision)
    && isNativeSeedReceiptOrNull(source.nativeSeedReceipt)
    && isAgentChatReference(source.reference)
    && isObject(target)
    && isResolvedHandoffTarget(target.execution)
    && nonEmptyString(target.agentOwnershipEpoch)
    && isCarryOverSegmentRefs(target.carryOverSegments)
    && typeof intent.createdAt === 'string';
}

function isTransferCleanup(value: unknown): value is SourceReleaseCleanup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cleanup = value as Record<string, unknown>;
  return cleanup.version === 1
    && typeof cleanup.operationId === 'string'
    && typeof cleanup.chatId === 'string'
    && isAgentChatReference(cleanup.source)
    && cleanup.reason === 'transferred'
    && (cleanup.status === 'pending' || cleanup.status === 'claimed' || cleanup.status === 'abandoned')
    && Number.isSafeInteger(cleanup.attempts)
    && Number(cleanup.attempts) >= 0
    && (cleanup.lastErrorCode === null || typeof cleanup.lastErrorCode === 'string');
}

function isResolvedHandoffTarget(value: unknown): value is ResolvedAgentHandoffTarget {
  if (!isObject(value)) return false;
  const settings = parseAgentSettingsEnvelope(value.agentSettings);
  return nonEmptyString(value.agentId)
    && typeof value.model === 'string'
    && nullableString(value.apiProviderId)
    && nullableString(value.modelEndpointId)
    && (
      value.modelProtocol === null
      || value.modelProtocol === 'anthropic-messages'
      || value.modelProtocol === 'openai-compatible'
    )
    && isPermissionMode(value.permissionMode)
    && isThinkingMode(value.thinkingMode)
    && settings !== null
    && settings.ownerId === value.agentId;
}

function isAgentChatReference(value: unknown): value is AgentChatReference {
  if (!isObject(value)) return false;
  const settings = parseAgentSettingsEnvelope(value.settings);
  return nonEmptyString(value.chatId)
    && nonEmptyString(value.agentId)
    && nullableString(value.agentSessionId)
    && typeof value.projectPath === 'string'
    && typeof value.model === 'string'
    && isNativeSessionOrNull(value.nativeSession, value.agentId)
    && typeof value.carryOverRevision === 'string'
    && isNativeSeedReceiptOrNull(value.nativeSeedReceipt)
    && settings !== null
    && settings.ownerId === value.agentId;
}

function isNativeSessionOrNull(value: unknown, agentId: string): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return value.ownerId === agentId
    && Number.isSafeInteger(value.schemaVersion)
    && Number(value.schemaVersion) >= 1
    && isObject(value.value);
}

function isNativeSeedReceiptOrNull(value: unknown): boolean {
  return value === null || parseNativeSeedReceipt(value) !== null;
}

function isCarryOverSegmentRefs(value: unknown): value is readonly CarryOverSegmentRef[] {
  try {
    parseCarryOverSegmentRefs(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
