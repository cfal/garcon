import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage, UserMessage } from '@garcon/common/chat-types';
import type { JsonObject } from '@garcon/common/json';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { orderedTranscriptDigest } from '@garcon/server-agent-interface';
import type {
  AgentChatReferenceV4,
  AgentControlEvent,
  AgentControlRow,
  AgentInputAdmissionState,
  AgentInputPreparation,
  AgentForkPoint,
  AgentNativeForkResolution,
  AgentNativeSessionRef,
  AgentOperationIdentityV4,
  AgentOutgoingHandoffLease,
  AgentProjectionState,
  AgentSegmentIdentity,
  AgentSegmentOpenResult,
  AgentStreamCheckpoint,
  AgentStreamEvent,
  AgentStreamReplayResult,
  AgentTerminalEvent,
  AgentTranscriptAccessResult,
  AgentTranscriptAdmissionIdentity,
  AgentTranscriptEntry,
  AgentTranscriptIndexRefreshRequestV4,
  AgentTranscriptIndexSourceRefV4,
  AgentTranscriptPageResultV4,
  AgentTranscriptPreview,
  AgentTranscriptProvenance,
  AgentTranscriptRequestV4,
  AgentTranscriptSourceIdentity,
  AgentTranscriptSourceLocation,
  AgentTranscriptStream,
  AgentTurnBoundOperationIdentityV4,
  AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import { getNativeMessageRevisionSource } from '@garcon/server-agent-interface';
import { AgentInputAdmissionCoordinator } from './admission.js';
import {
  prepareIncomingOwnershipSegment,
  prepareOutgoingHandoffLease,
  AgentProjectionMutationGate,
} from './handoff.js';
import {
  agentTranscriptEntryId,
  newAgentStreamEpoch,
  sourceIdentityKey,
} from './identity.js';
import { AgentProjectionJournal } from './journal.js';
import { AgentProjectionPager } from './paging.js';
import { createProjectionMaterialization } from './state.js';
import { AgentProjectionEventStream } from './stream.js';

export interface AgentTranscriptSeedEntry {
  readonly message: ChatMessage;
  readonly source: AgentTranscriptSourceIdentity;
  readonly provenance?: AgentTranscriptProvenance | null;
  readonly entryId?: AgentTranscriptEntry['id'];
}

export interface JournalBackedTranscriptStreamOptions {
  readonly ownerId: string;
  readonly directory: () => Promise<string>;
  readonly bootstrap: (
    request: AgentTranscriptRequestV4,
  ) => Promise<AgentTranscriptAccessResult<readonly AgentTranscriptSeedEntry[]>>;
  readonly resolveNativeSession?: (
    request: AgentTranscriptRequestV4,
  ) => Promise<AgentTranscriptAccessResult<AgentNativeSessionRef | null>>;
  readonly describeSource?: (
    request: AgentTranscriptRequestV4,
  ) => Promise<AgentTranscriptAccessResult<AgentTranscriptSourceLocation | null>>;
  readonly releaseProvider?: (
    request: AgentTranscriptRequestV4 & { readonly reason: 'deleted' | 'transferred' },
  ) => Promise<void>;
}

interface OpenSegment {
  readonly identity: AgentSegmentIdentity;
  readonly chat: AgentChatReferenceV4;
  readonly journal: AgentProjectionJournal;
  readonly stream: AgentProjectionEventStream;
  readonly admission: AgentInputAdmissionCoordinator;
  readonly pager: AgentProjectionPager;
  readonly gate: AgentProjectionMutationGate;
  readonly handoffHealth: {
    cleanupBlock: Promise<void> | null;
    operationId: string | null;
  };
  forwarded: boolean;
}

export class JournalBackedAgentTranscriptStream implements AgentTranscriptStream {
  readonly #segments = new Map<string, OpenSegment>();
  readonly #listeners = new Set<(event: AgentStreamEvent) => void>();
  readonly #preparations = new Map<string, OpenSegment>();

  constructor(private readonly options: JournalBackedTranscriptStreamOptions) {}

  subscribe(listener: (event: AgentStreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async openSegment(
    request: AgentTranscriptRequestV4,
  ): Promise<AgentTranscriptAccessResult<AgentSegmentOpenResult>> {
    request.signal.throwIfAborted();
    const key = segmentKey(request.chat);
    const existing = this.#segments.get(key);
    if (existing) {
      return { kind: 'ready', value: { checkpoint: existing.stream.current.checkpoint, idle: true } };
    }
    const directory = await this.options.directory();
    request.signal.throwIfAborted();
    const exists = await AgentProjectionJournal.exists({ directory, ...segmentIdentity(request.chat) });
    let seeds: readonly AgentTranscriptSeedEntry[] = [];
    if (!exists) {
      const bootstrap = await this.options.bootstrap(request);
      if (bootstrap.kind !== 'ready') return bootstrap;
      seeds = bootstrap.value;
    }
    const entries = seedEntries(request.chat, seeds);
    const bootstrapAliases = aliasesFromSeeds(seeds);
    const journal = await AgentProjectionJournal.open({
      directory,
      ...segmentIdentity(request.chat),
      bootstrapEntries: entries,
      bootstrapAliases,
    });
    request.signal.throwIfAborted();
    const segment = this.#createSegment(request.chat, journal);
    this.#segments.set(key, segment);
    return { kind: 'ready', value: { checkpoint: segment.stream.current.checkpoint, idle: true } };
  }

  async replay(
    request: AgentTranscriptRequestV4 & { readonly after: AgentStreamCheckpoint },
  ): Promise<AgentStreamReplayResult> {
    request.signal.throwIfAborted();
    const segment = this.#segments.get(segmentKey(request.chat));
    if (!segment) return { kind: 'expired', checkpoint: request.after };
    return segment.stream.replay(request.after);
  }

  async loadPage(request: AgentTranscriptRequestV4 & {
    readonly limit: number;
    readonly beforeOrdinal: number | null;
    readonly expectedProjection: AgentProjectionState | null;
  }): Promise<AgentTranscriptPageResultV4> {
    request.signal.throwIfAborted();
    const opened = await this.#requireOpen(request);
    if (opened.kind !== 'ready') return opened;
    const segment = opened.value;
    return segment.pager.page({
      current: segment.stream.current.checkpoint.projection,
      entries: segment.stream.current.entries,
      expected: request.expectedProjection,
      beforeOrdinal: request.beforeOrdinal,
      limit: request.limit,
    });
  }

  async commitOffset(request: AgentTranscriptRequestV4 & {
    readonly commit: import('@garcon/server-agent-interface').AgentConsumerOffsetCommit;
  }): Promise<void> {
    request.signal.throwIfAborted();
    this.#open(request.chat).stream.commitOffset(request.commit);
  }

  async prepareInput(request: AgentTranscriptRequestV4 & {
    readonly message: UserMessage;
    readonly operation: AgentTranscriptAdmissionIdentity;
  }): Promise<AgentInputPreparation> {
    request.signal.throwIfAborted();
    const segment = this.#open(request.chat);
    const prepared = segment.admission.prepare(request.message, request.operation);
    return {
      commit: () => segment.gate.run(() => prepared.commit()),
      rollback: () => segment.gate.run(() => prepared.rollback()),
      discardCommitted: () => segment.gate.run(() => prepared.discardCommitted()),
    };
  }

  async resolveInputAdmission(request: AgentTranscriptRequestV4 & {
    readonly operation: AgentTranscriptAdmissionIdentity;
  }): Promise<AgentInputAdmissionState> {
    request.signal.throwIfAborted();
    const segment = this.#open(request.chat);
    const inMemory = segment.admission.resolve(request.operation);
    if (inMemory.kind !== 'absent') return inMemory;
    const discarded = segment.journal.resolveDiscardedAdmission(request.operation);
    return discarded
      ? { kind: 'discarded-settled', entryId: agentTranscriptEntryId(discarded.entryId) }
      : inMemory;
  }

  async prepareHandoffLease(request: AgentTranscriptRequestV4 & {
    readonly handoffOperationId: string;
  }) {
    request.signal.throwIfAborted();
    const segment = this.#open(request.chat);
    if (segment.handoffHealth.operationId
        && segment.handoffHealth.operationId !== request.handoffOperationId) {
      throw new TypeError('Outgoing projection already has a different handoff lease');
    }
    segment.handoffHealth.operationId = request.handoffOperationId;
    let lease: AgentOutgoingHandoffLease;
    try {
      lease = await prepareOutgoingHandoffLease({
        operationId: request.handoffOperationId,
        gate: segment.gate,
        materialization: () => segment.stream.current,
        afterDecision: async () => {},
        beforeRollback: async () => {
          segment.handoffHealth.operationId = null;
        },
      });
    } catch (error) {
      segment.handoffHealth.operationId = null;
      throw error;
    }
    return { kind: 'ready' as const, value: lease };
  }

  async prepareOwnershipSegment(request: AgentTranscriptRequestV4 & {
    readonly handoffOperationId: string;
  }) {
    request.signal.throwIfAborted();
    const key = preparationKey(request.handoffOperationId, request.chat);
    const active = this.#segments.get(segmentKey(request.chat));
    if (active) {
      return {
        kind: 'ready' as const,
        value: prepareIncomingOwnershipSegment({
          checkpoint: active.stream.current.checkpoint,
          commit: async (decision) => this.#validateDecision(request, decision),
          rollback: async () => {
            throw new TypeError('Active ownership segment cannot roll back');
          },
        }),
      };
    }
    const existing = this.#preparations.get(key);
    if (existing) {
      return {
        kind: 'ready' as const,
        value: prepareIncomingOwnershipSegment({
          checkpoint: existing.stream.current.checkpoint,
          commit: async (decision) => {
            this.#validateDecision(request, decision);
            this.#activatePreparation(key, request.chat, existing);
          },
          rollback: async () => this.#rollbackPreparation(key, existing),
        }),
      };
    }
    const directory = await this.options.directory();
    const journal = await AgentProjectionJournal.open({
      directory,
      ...segmentIdentity(request.chat),
      bootstrapEntries: [],
    });
    const segment = this.#createSegment(request.chat, journal, false);
    this.#preparations.set(key, segment);
    const preparation = prepareIncomingOwnershipSegment({
      checkpoint: segment.stream.current.checkpoint,
      commit: async (decision) => {
        this.#validateDecision(request, decision);
        this.#activatePreparation(key, request.chat, segment);
      },
      rollback: async () => this.#rollbackPreparation(key, segment),
    });
    return { kind: 'ready' as const, value: preparation };
  }

  async resolveNativeSession(request: AgentTranscriptRequestV4) {
    if (!this.options.resolveNativeSession) return { kind: 'ready' as const, value: null };
    return this.options.resolveNativeSession(request);
  }

  async preview(request: AgentTranscriptRequestV4): Promise<AgentTranscriptAccessResult<AgentTranscriptPreview | null>> {
    request.signal.throwIfAborted();
    const opened = await this.#requireOpen(request);
    if (opened.kind !== 'ready') return opened;
    const entries = opened.value.stream.current.entries.slice(
      0,
      opened.value.stream.current.checkpoint.projection.durableCount,
    );
    if (!entries.length) return { kind: 'ready', value: null };
    const first = entries[0]!.message;
    const last = entries.at(-1)!.message;
    return {
      kind: 'ready',
      value: {
        firstMessage: previewText(first),
        lastMessage: previewText(last),
        createdAt: messageTimestamp(first),
        lastActivity: messageTimestamp(last),
      },
    };
  }

  async resolveIndexSource(
    request: AgentTranscriptRequestV4,
  ): Promise<AgentTranscriptAccessResult<AgentTranscriptIndexSourceRefV4 | null>> {
    request.signal.throwIfAborted();
    const opened = await this.#requireOpen(request);
    return opened.kind === 'ready'
      ? { kind: 'ready', value: opened.value.journal.indexSource(this.options.ownerId) }
      : opened;
  }

  async refreshIndexSource(
    request: AgentTranscriptIndexRefreshRequestV4,
  ): Promise<AgentTranscriptAccessResult<AgentTranscriptIndexSourceRefV4 | null>> {
    return this.resolveIndexSource(request);
  }

  async resolveNativeForkPoint(request: AgentTranscriptRequestV4 & {
    readonly point: AgentForkPoint;
  }): Promise<AgentNativeForkResolution> {
    request.signal.throwIfAborted();
    const opened = await this.#requireOpen(request);
    if (opened.kind === 'deferred') {
      return { kind: 'unavailable', reason: 'not-settled' };
    }
    if (opened.kind === 'degraded') return opened;
    const segment = opened.value;
    const checkpoint = segment.stream.current.checkpoint;
    if (request.point.agentOwnershipEpoch !== request.chat.agentOwnershipEpoch
        || request.point.contentEpoch !== checkpoint.projection.contentEpoch
        || request.point.durableRevision !== checkpoint.projection.durableRevision) {
      return { kind: 'unavailable', reason: 'source-diverged' };
    }
    const ordinal = segment.stream.current.entries.findIndex(
      (entry) => entry.id === request.point.entryId,
    ) + 1;
    if (ordinal === 0) return { kind: 'unavailable', reason: 'source-diverged' };
    const entry = segment.stream.current.entries[ordinal - 1]!;
    if (entry.lifetime !== 'durable') return { kind: 'unavailable', reason: 'not-settled' };
    const journal = segment.journal.state;
    if (ordinal <= journal.nativeRetentionFloor) {
      return { kind: 'unavailable', reason: 'below-native-retention-floor' };
    }
    if (!entry.source) return { kind: 'unavailable', reason: 'no-native-source' };
    const alias = journal.aliases[sourceIdentityKey(entry.source)];
    const prefix = segment.stream.current.entries.slice(0, ordinal);
    const lineCounts: Record<string, number> = {};
    let firstLine: number | null = null;
    for (const candidate of prefix) {
      if (!candidate.source) return { kind: 'unavailable', reason: 'no-native-source' };
      const candidateAlias = journal.aliases[sourceIdentityKey(candidate.source)];
      const lineNumber = nativeAliasLineNumber(candidateAlias);
      if (lineNumber === null) continue;
      firstLine = firstLine === null ? lineNumber : Math.min(firstLine, lineNumber);
      lineCounts[String(lineNumber)] = (lineCounts[String(lineNumber)] ?? 0) + 1;
    }
    return {
      kind: 'ready',
      reference: {
        ownerId: this.options.ownerId,
        schemaVersion: 1,
        value: {
          ordinal,
          entryId: entry.id,
          source: { ...entry.source },
          ...(alias && typeof alias === 'object' && !Array.isArray(alias)
            ? { alias }
            : {}),
          prefix: {
            semanticDigest: orderedTranscriptDigest(prefix.map((candidate, index) => ({
              seq: index + 1,
              message: candidate.message,
            }))),
            firstLine,
            lineCounts,
          },
        },
      },
    };
  }

  async describeSource(request: AgentTranscriptRequestV4) {
    if (this.options.describeSource) return this.options.describeSource(request);
    request.signal.throwIfAborted();
    const opened = await this.#requireOpen(request);
    return opened.kind === 'ready'
      ? { kind: 'ready' as const, value: { kind: 'filesystem-path' as const, value: opened.value.journal.filePath } }
      : opened;
  }

  async release(request: AgentTranscriptRequestV4 & { readonly reason: 'deleted' | 'transferred' }): Promise<void> {
    request.signal.throwIfAborted();
    const key = segmentKey(request.chat);
    const segment = this.#segments.get(key);
    const directory = await this.options.directory();
    const journalOptions = {
      directory,
      ...segmentIdentity(request.chat),
    };
    const retainedJournal = segment?.journal
      ?? (await AgentProjectionJournal.exists(journalOptions)
        ? await AgentProjectionJournal.open(journalOptions)
        : null);
    if (segment?.handoffHealth.cleanupBlock) await segment.handoffHealth.cleanupBlock;
    if (request.reason === 'transferred' && retainedJournal?.state.handoffCleanupBlocked) {
      throw new AgentIntegrationError(
        'PROJECTION_HANDOFF_POST_BOUNDARY_EVENT',
        'The outgoing projection observed a mutation after the handoff boundary',
        false,
      );
    }
    await this.options.releaseProvider?.(request);
    await AgentProjectionJournal.delete(journalOptions);
    if (this.#segments.get(key) === segment) this.#segments.delete(key);
  }

  async promoteActiveInput(
    chat: AgentChatReferenceV4,
    operation: AgentTurnBoundOperationIdentityV4,
    source?: AgentTranscriptSourceIdentity,
  ): Promise<void> {
    const segment = this.#open(chat);
    await segment.gate.run(async () => {
      const active = segment.stream.current.entries.at(-1);
      if (!active || active.lifetime !== 'active') return;
      if (!sameTurnOwner(active.provenance?.turnOwner, operation.turnOwner)) {
        throw new TypeError('Active admission does not belong to the delivered operation');
      }
      await segment.stream.commit([{
        entryId: active.id,
        source: source ?? admissionSource(active.provenance ?? operation),
      }], []);
    });
  }

  async appendMessages(options: {
    readonly chat: AgentChatReferenceV4;
    readonly operation: AgentTurnBoundOperationIdentityV4 | null;
    readonly messages: readonly ChatMessage[];
    readonly upstreamRequestId?: string | null;
    readonly sourceNamespace?: string;
  }): Promise<readonly AgentTranscriptEntry[]> {
    if (!options.messages.length) return [];
    const segment = this.#open(options.chat);
    return segment.gate.run(async () => {
      const active = segment.stream.current.entries.at(-1);
      if (active?.lifetime === 'active' && options.operation
          && sameTurnOwner(active.provenance?.turnOwner, options.operation.turnOwner)) {
        await segment.stream.commit([{
          entryId: active.id,
          source: admissionSource(active.provenance ?? options.operation),
        }], []);
      }
      const batchId = randomUUID();
      const existingSources = new Set(
        segment.stream.current.entries.flatMap((entry) => entry.source ? [sourceIdentityKey(entry.source)] : []),
      );
      const appended = options.messages.flatMap((message, index) => {
        const source = messageSource(
          this.options.ownerId,
          options.sourceNamespace,
          message,
          index,
          batchId,
        );
        if (existingSources.has(sourceIdentityKey(source))) return [];
        existingSources.add(sourceIdentityKey(source));
        const provenance = options.operation ? {
          ...options.operation,
          upstreamRequestId: options.upstreamRequestId ?? null,
        } : null;
        return [{
          id: deterministicEntryId(segment.identity, source),
          lifetime: 'durable' as const,
          source,
          provenance,
          message,
        }];
      });
      if (appended.length) {
        await segment.stream.commit([], appended);
        await persistNativeAliases(segment, appended);
      }
      return appended;
    });
  }

  async emitControl(
    chat: AgentChatReferenceV4,
    operation: AgentTurnBoundOperationIdentityV4,
    mutation: AgentControlEvent['mutation'],
  ): Promise<AgentControlEvent> {
    const segment = this.#open(chat);
    return segment.gate.run(() => segment.stream.control(operation, mutation));
  }

  async emitSession(
    chat: AgentChatReferenceV4,
    operation: AgentOperationIdentityV4,
    session: import('@garcon/server-agent-interface').AgentStartedSession,
  ) {
    const segment = this.#open(chat);
    return segment.gate.run(() => segment.stream.session(operation, session));
  }

  async emitTerminal(options: {
    readonly chat: AgentChatReferenceV4;
    readonly operation: AgentTurnOwnerOperationIdentityV4;
    readonly outcome: AgentTerminalEvent['outcome'];
    readonly sourceSettlement: AgentTerminalEvent['sourceSettlement'];
  }): Promise<AgentTerminalEvent> {
    const segment = this.#open(options.chat);
    return segment.gate.run(async () => {
      const active = segment.stream.current.entries.at(-1);
      if (active?.lifetime === 'active'
          && options.sourceSettlement === 'confirmed'
          && sameTurnOwner(active.provenance?.turnOwner, options.operation.turnOwner)) {
        await segment.stream.commit([{
          entryId: active.id,
          source: admissionSource(active.provenance ?? options.operation),
        }], []);
      }
      const attributable = segment.stream.current.entries.filter((entry) => (
        entry.provenance?.turnOwner.clientRequestId === options.operation.turnOwner.clientRequestId
        && entry.provenance.turnOwner.turnId === options.operation.turnOwner.turnId
      ));
      const accepted = attributable.filter((entry) => entry.message.type === 'user-message');
      return segment.stream.terminal({
        operation: options.operation,
        outcome: options.outcome,
        completeness: {
          acceptedInputEntryIds: accepted.map((entry) => entry.id),
          attributableEntryCount: attributable.length,
        },
        sourceSettlement: options.sourceSettlement,
      });
    });
  }

  referenceForOperation(
    chatId: string,
    operation: Pick<AgentOperationIdentityV4, 'agentOwnershipEpoch'>,
  ): AgentChatReferenceV4 | null {
    for (const segment of this.#segments.values()) {
      if (segment.chat.chatId === chatId
          && segment.chat.agentOwnershipEpoch === operation.agentOwnershipEpoch) {
        return segment.chat;
      }
    }
    return null;
  }

  #createSegment(
    chat: AgentChatReferenceV4,
    journal: AgentProjectionJournal,
    forward = true,
  ): OpenSegment {
    const state = journal.state;
    const initial = createProjectionMaterialization({
      ...segmentIdentity(chat),
      epoch: newAgentStreamEpoch(),
      contentEpoch: state.contentEpoch,
      entries: state.entries,
    });
    const stream = new AgentProjectionEventStream({
      initial,
      persist: (event, previous, resulting) => journal.persist(event, previous, resulting),
    });
    const handoffHealth: OpenSegment['handoffHealth'] = {
      cleanupBlock: state.handoffCleanupBlocked
        ? Promise.resolve()
        : null,
      operationId: null,
    };
    const segment: OpenSegment = {
      identity: segmentIdentity(chat),
      chat,
      journal,
      stream,
      admission: new AgentInputAdmissionCoordinator(stream),
      pager: new AgentProjectionPager(),
      gate: new AgentProjectionMutationGate(() => {
        handoffHealth.cleanupBlock ??= journal.markHandoffBoundaryViolation(
          handoffHealth.operationId ?? 'unknown-handoff',
        );
        return handoffHealth.cleanupBlock;
      }),
      handoffHealth,
      forwarded: false,
    };
    segment.pager.retain(initial.checkpoint.projection, initial.entries);
    if (forward) this.#forward(segment);
    return segment;
  }

  #forward(segment: OpenSegment): void {
    if (segment.forwarded) return;
    segment.forwarded = true;
    segment.stream.subscribe((event) => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  #validateDecision(
    request: AgentTranscriptRequestV4 & { readonly handoffOperationId: string },
    decision: import('@garcon/server-agent-interface').AgentHandoffDecision,
  ): void {
    if (decision.operationId !== request.handoffOperationId
        || decision.targetOwnershipEpoch !== request.chat.agentOwnershipEpoch) {
      throw new TypeError('Incoming ownership decision does not match preparation');
    }
  }

  #activatePreparation(
    key: string,
    chat: AgentChatReferenceV4,
    segment: OpenSegment,
  ): void {
    this.#segments.set(segmentKey(chat), segment);
    this.#preparations.delete(key);
    this.#forward(segment);
  }

  async #rollbackPreparation(key: string, segment: OpenSegment): Promise<void> {
    if (this.#segments.get(segmentKey(segment.chat)) === segment) {
      throw new TypeError('Active ownership segment cannot roll back');
    }
    this.#preparations.delete(key);
    await segment.journal.delete();
  }

  async #requireOpen(
    request: AgentTranscriptRequestV4,
  ): Promise<AgentTranscriptAccessResult<OpenSegment>> {
    const existing = this.#segments.get(segmentKey(request.chat));
    if (existing) return { kind: 'ready', value: existing };
    const opened = await this.openSegment(request);
    if (opened.kind !== 'ready') return opened;
    return { kind: 'ready', value: this.#open(request.chat) };
  }

  #open(chat: AgentChatReferenceV4): OpenSegment {
    const segment = this.#segments.get(segmentKey(chat));
    if (!segment) throw new TypeError(`Projection segment ${chat.chatId} is not open`);
    return segment;
  }
}

export function transcriptSeedEntries(
  ownerId: string,
  messages: readonly ChatMessage[],
  sourceNamespace = `${ownerId}:native`,
): readonly AgentTranscriptSeedEntry[] {
  const batchId = randomUUID();
  return messages.map((message, index) => ({
    message,
    source: messageSource(ownerId, sourceNamespace, message, index, batchId),
  }));
}

function seedEntries(
  chat: AgentChatReferenceV4,
  seeds: readonly AgentTranscriptSeedEntry[],
): readonly AgentTranscriptEntry[] {
  const identity = segmentIdentity(chat);
  const seenSources = new Set<string>();
  return seeds.map((seed) => {
    const sourceKey = sourceIdentityKey(seed.source);
    if (seenSources.has(sourceKey)) throw new TypeError('Bootstrap source identities must be unique');
    seenSources.add(sourceKey);
    return {
      id: seed.entryId ?? deterministicEntryId(identity, seed.source),
      lifetime: 'durable' as const,
      source: seed.source,
      provenance: seed.provenance ?? null,
      message: seed.message,
    };
  });
}

function deterministicEntryId(
  identity: AgentSegmentIdentity,
  source: AgentTranscriptSourceIdentity,
): AgentTranscriptEntry['id'] {
  return agentTranscriptEntryId(`entry-v1:${createHash('sha256')
    .update(`${identity.chatId}\0${identity.agentOwnershipEpoch}\0${sourceIdentityKey(source)}`)
    .digest('hex')}`);
}

function messageSource(
  ownerId: string,
  namespace: string | undefined,
  message: ChatMessage,
  index: number,
  fallbackBatchId: string,
): AgentTranscriptSourceIdentity {
  const native = getNativeMessageRevisionSource(message);
  const itemId = native?.entryId
    ?? (native?.byteOffset !== undefined ? `byte:${native.byteOffset}` : null)
    ?? (native?.lineNumber !== undefined ? `line:${native.lineNumber}` : null)
    ?? `event:${fallbackBatchId}`;
  const subrow = native?.withinSourceOrdinal ?? index;
  return {
    namespace: namespace ?? `${ownerId}:native`,
    itemId,
    subrowId: `row:${subrow}`,
  };
}

function admissionSource(operation: AgentTurnBoundOperationIdentityV4): AgentTranscriptSourceIdentity {
  return {
    namespace: 'garcon:admission',
    itemId: operation.clientRequestId ?? operation.turnId,
    subrowId: 'user',
  };
}

function sameTurnOwner(
  left: AgentTurnBoundOperationIdentityV4['turnOwner'] | undefined,
  right: AgentTurnBoundOperationIdentityV4['turnOwner'],
): boolean {
  return left?.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.clientRequestId === right.clientRequestId
    && left.turnId === right.turnId;
}

function segmentIdentity(chat: AgentChatReferenceV4): AgentSegmentIdentity {
  return { chatId: chat.chatId, agentOwnershipEpoch: chat.agentOwnershipEpoch };
}

function segmentKey(chat: AgentChatReferenceV4): string {
  return `${chat.chatId.length}:${chat.chatId}${chat.agentOwnershipEpoch}`;
}

function preparationKey(operationId: string, chat: AgentChatReferenceV4): string {
  return `${operationId}:${segmentKey(chat)}`;
}

function previewText(message: ChatMessage): string {
  if ('content' in message && typeof message.content === 'string') return message.content;
  if ('summary' in message && typeof message.summary === 'string') return message.summary;
  if ('command' in message && typeof message.command === 'string') return message.command;
  return '';
}

function messageTimestamp(message: ChatMessage): string | null {
  return 'timestamp' in message && typeof message.timestamp === 'string'
    ? message.timestamp
    : null;
}

function aliasesFromSeeds(seeds: readonly AgentTranscriptSeedEntry[]): JsonObject {
  return Object.fromEntries(seeds.flatMap((seed) => {
    const alias = nativeAlias(seed.message);
    return alias ? [[sourceIdentityKey(seed.source), alias] as const] : [];
  }));
}

async function persistNativeAliases(
  segment: OpenSegment,
  entries: readonly AgentTranscriptEntry[],
): Promise<void> {
  const additions = entries.flatMap((entry) => {
    const alias = entry.source ? nativeAlias(entry.message) : null;
    return alias && entry.source
      ? [[sourceIdentityKey(entry.source), alias] as const]
      : [];
  });
  if (!additions.length) return;
  const state = segment.journal.state;
  await segment.journal.updateNativeMetadata({
    nativeRetentionFloor: state.nativeRetentionFloor,
    aliases: { ...state.aliases, ...Object.fromEntries(additions) },
  });
}

function nativeAlias(message: ChatMessage): JsonObject | null {
  const source = getNativeMessageRevisionSource(message);
  if (!source) return null;
  return {
    ...(source.entryId ? { entryId: source.entryId } : {}),
    ...(source.lineNumber !== undefined ? { lineNumber: source.lineNumber } : {}),
    ...(source.byteOffset !== undefined ? { byteOffset: source.byteOffset } : {}),
    ...(source.withinSourceOrdinal !== undefined
      ? { withinSourceOrdinal: source.withinSourceOrdinal }
      : {}),
  };
}

function nativeAliasLineNumber(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lineNumber = (value as Record<string, unknown>).lineNumber;
  return typeof lineNumber === 'number' && Number.isSafeInteger(lineNumber) && lineNumber > 0
    ? lineNumber
    : null;
}
