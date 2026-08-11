import type {
  AgentChatReferenceV4,
  AgentIntegrationV4,
  AgentProjectionState,
  AgentStreamCheckpoint,
  AgentStreamEvent,
  AgentTranscriptAccessResult,
  AgentTranscriptEntry,
  AgentTranscriptPageResultV4,
  AgentTurnReceiptOwner,
} from '@garcon/server-agent-interface';
import {
  applyProjectionEvent,
} from '@garcon/server-agent-common/transcript-projection/apply';
import {
  compareAgentStreamOffsets,
  sameCheckpoint,
  sameProjectionState,
} from '@garcon/server-agent-common/transcript-projection/identity';
import {
  createProjectionMaterialization,
  type AgentProjectionMaterialization,
} from '@garcon/server-agent-common/transcript-projection/state';
import { stageProjectionReset } from '@garcon/server-agent-common/transcript-projection/reset';

const PAGE_SIZE = 500;
const SUPERSEDED_EPOCH_LIMIT = 16;
const OFFSET_COMMIT_RETRY_MS = 25;

interface TurnProjectionSummary {
  readonly owner: AgentTurnReceiptOwner;
  attributableEntryCount: number;
  readonly acceptedInputEntryIds: string[];
  readonly entryLifetimeById: Map<string, AgentTranscriptEntry['lifetime']>;
}

interface IngressRecord {
  readonly integration: AgentIntegrationV4;
  readonly chat: AgentChatReferenceV4;
  materialization: AgentProjectionMaterialization;
  committed: AgentStreamCheckpoint;
  readonly proofs: Map<string, AgentStreamEvent>;
  readonly supersededEpochs: Set<string>;
  readonly turnSummaries: Map<string, TurnProjectionSummary>;
  initializing: boolean;
  offsetCommitTask: Promise<void> | null;
  readonly closeController: AbortController;
  blockedError: unknown | null;
  failureReported: boolean;
}

export interface AppliedProjectionEvent {
  readonly event: AgentStreamEvent;
  readonly previous: AgentProjectionMaterialization;
  readonly current: AgentProjectionMaterialization;
}

export type ProjectionIngressApply = (
  applied: AppliedProjectionEvent,
) => Promise<void>;

export interface ProjectionIngressFailure {
  readonly integration: AgentIntegrationV4;
  readonly chat: AgentChatReferenceV4;
  readonly event: AgentStreamEvent;
  readonly materialization: AgentProjectionMaterialization;
  readonly error: unknown;
}

export type ProjectionIngressFailureHandler = (
  failure: ProjectionIngressFailure,
) => Promise<void>;

export class AgentProjectionIngress {
  readonly #records = new Map<string, IngressRecord>();
  readonly #pending = new Map<string, { integration: AgentIntegrationV4; event: AgentStreamEvent }[]>();
  readonly #opening = new Map<string, Promise<AgentTranscriptAccessResult<AgentProjectionMaterialization>>>();
  readonly #chains = new Map<string, Promise<void>>();
  readonly #unsubscribers: (() => void)[] = [];
  #apply: ProjectionIngressApply = async () => {};
  #onFailure: ProjectionIngressFailureHandler = async () => {};

  constructor(integrations: readonly AgentIntegrationV4[]) {
    for (const integration of integrations) {
      this.#unsubscribers.push(integration.transcript.subscribe((event) => {
        this.#receive(integration, event);
      }));
    }
  }

  onApply(apply: ProjectionIngressApply): void {
    this.#apply = apply;
  }

  onFailure(handler: ProjectionIngressFailureHandler): void {
    this.#onFailure = handler;
  }

  async open(
    integration: AgentIntegrationV4,
    chat: AgentChatReferenceV4,
    signal: AbortSignal,
  ): Promise<AgentTranscriptAccessResult<AgentProjectionMaterialization>> {
    signal.throwIfAborted();
    const key = segmentKey(chat);
    const existing = this.#records.get(key);
    if (existing) {
      return existing.blockedError
        ? { kind: 'degraded', errorCode: 'PROJECTION_REPAIR_REQUIRED', retryable: true }
        : { kind: 'ready', value: existing.materialization };
    }
    const opening = this.#opening.get(key);
    if (opening) return opening;
    const promise = this.#open(integration, chat, signal).finally(() => {
      this.#opening.delete(key);
    });
    this.#opening.set(key, promise);
    return promise;
  }

  current(chat: AgentChatReferenceV4): AgentProjectionMaterialization | null {
    return this.#records.get(segmentKey(chat))?.materialization ?? null;
  }

  fence(chat: AgentChatReferenceV4, error: unknown): void {
    const record = this.#records.get(segmentKey(chat));
    if (record) record.blockedError ??= error;
  }

  async applyReturnedEvent(
    integration: AgentIntegrationV4,
    chat: AgentChatReferenceV4,
    event: AgentStreamEvent,
  ): Promise<void> {
    await this.#enqueue(segmentKey(chat), () => this.#applyThrough(integration, chat, event));
  }

  async page(options: {
    readonly integration: AgentIntegrationV4;
    readonly chat: AgentChatReferenceV4;
    readonly signal: AbortSignal;
    readonly limit: number;
    readonly beforeOrdinal: number | null;
    readonly expectedProjection: AgentProjectionState | null;
  }): Promise<AgentTranscriptPageResultV4> {
    const opened = await this.open(options.integration, options.chat, options.signal);
    if (opened.kind !== 'ready') return opened;
    return options.integration.transcript.loadPage({
      chat: options.chat,
      signal: options.signal,
      limit: options.limit,
      beforeOrdinal: options.beforeOrdinal,
      expectedProjection: options.expectedProjection,
    });
  }

  closeSegment(chat: AgentChatReferenceV4): void {
    const key = segmentKey(chat);
    this.#records.get(key)?.closeController.abort();
    this.#records.delete(key);
    this.#pending.delete(key);
    this.#opening.delete(key);
    this.#chains.delete(key);
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    for (const record of this.#records.values()) record.closeController.abort();
    this.#records.clear();
    this.#pending.clear();
    this.#opening.clear();
    this.#chains.clear();
  }

  async #open(
    integration: AgentIntegrationV4,
    chat: AgentChatReferenceV4,
    signal: AbortSignal,
  ): Promise<AgentTranscriptAccessResult<AgentProjectionMaterialization>> {
    const opened = await integration.transcript.openSegment({ chat, signal });
    if (opened.kind !== 'ready') return opened;
    const checkpoint = opened.value.checkpoint;
    assertCheckpointOwnership(checkpoint, chat);
    const entries = await loadCompleteProjection(integration, chat, checkpoint.projection, signal);
    if ('kind' in entries) {
      return entries.kind === 'expired'
        ? { kind: 'degraded', errorCode: 'PROJECTION_OPEN_EXPIRED', retryable: true }
        : entries;
    }
    const created = createProjectionMaterialization({
      chatId: chat.chatId,
      agentOwnershipEpoch: chat.agentOwnershipEpoch,
      epoch: checkpoint.projection.epoch,
      contentEpoch: checkpoint.projection.contentEpoch,
      entries,
    });
    if (!sameProjectionState(created.checkpoint.projection, checkpoint.projection)) {
      return { kind: 'degraded', errorCode: 'PROJECTION_OPEN_MISMATCH', retryable: true };
    }
    const materialization: AgentProjectionMaterialization = { ...created, checkpoint };
    const record: IngressRecord = {
      integration,
      chat,
      materialization,
      committed: checkpoint,
      proofs: new Map(),
      supersededEpochs: new Set(),
      turnSummaries: new Map(),
      initializing: true,
      offsetCommitTask: null,
      closeController: new AbortController(),
      blockedError: null,
      failureReported: false,
    };
    const key = segmentKey(chat);
    this.#records.set(key, record);
    while (true) {
      const buffered = this.#pending.get(key) ?? [];
      this.#pending.delete(key);
      for (const value of buffered) {
        if (value.integration !== integration) continue;
        await this.#applyThrough(integration, chat, value.event);
      }
      if (!this.#pending.has(key)) break;
    }
    record.initializing = false;
    return { kind: 'ready', value: record.materialization };
  }

  #receive(integration: AgentIntegrationV4, event: AgentStreamEvent): void {
    const key = eventKey(event);
    const record = this.#records.get(key);
    if (!record || record.initializing) {
      const pending = this.#pending.get(key) ?? [];
      pending.push({ integration, event });
      this.#pending.set(key, pending);
      return;
    }
    void this.#enqueue(key, () => this.#applyThrough(integration, record.chat, event))
      .catch(async (error) => {
        record.blockedError ??= error;
        if (record.failureReported) return;
        record.failureReported = true;
        try {
          await this.#onFailure({
            integration,
            chat: record.chat,
            event,
            materialization: record.materialization,
            error,
          });
        } catch {
          // The projection remains fenced even when failure publication also fails.
        }
      });
  }

  async #applyThrough(
    integration: AgentIntegrationV4,
    chat: AgentChatReferenceV4,
    event: AgentStreamEvent,
  ): Promise<void> {
    const record = this.#records.get(segmentKey(chat));
    if (!record || record.integration !== integration) return;
    if (record.blockedError) throw record.blockedError;
    if (event.agentOwnershipEpoch !== chat.agentOwnershipEpoch || event.chatId !== chat.chatId) return;
    const relation = classify(record, event);
    if (relation === 'settled' || relation === 'duplicate' || relation === 'stale') return;
    if (relation === 'corrupt') {
      const error = new Error('PROJECTION_EVENT_CORRUPT');
      record.blockedError = error;
      throw error;
    }
    if (relation === 'unknown') {
      const error = new Error('PROJECTION_STREAM_UNKNOWN_EPOCH');
      record.blockedError = error;
      throw error;
    }
    if (relation === 'gap') {
      const replay = await integration.transcript.replay({
        chat,
        signal: AbortSignal.timeout(10_000),
        after: record.materialization.checkpoint,
      });
      if (replay.kind !== 'events') {
        const error = new Error(`PROJECTION_STREAM_${replay.kind.toUpperCase()}`);
        record.blockedError = error;
        throw error;
      }
      for (const replayed of replay.events) await this.#applyNext(record, replayed);
      const afterReplay = classify(record, event);
      if (afterReplay === 'settled' || afterReplay === 'duplicate') return;
      if (afterReplay !== 'next') throw new Error('PROJECTION_REPLAY_NOT_CONTIGUOUS');
    }
    await this.#applyNext(record, event);
  }

  async #applyNext(record: IngressRecord, event: AgentStreamEvent): Promise<void> {
    const previous = record.materialization;
    let resetEntries: readonly AgentTranscriptEntry[] | undefined;
    if (event.kind === 'reset') {
      const staged = await stageProjectionReset({
        target: event.checkpoint.projection,
        pageSize: PAGE_SIZE,
        loadPage: (beforeOrdinal, expected) => record.integration.transcript.loadPage({
          chat: record.chat,
          signal: AbortSignal.timeout(10_000),
          limit: PAGE_SIZE,
          beforeOrdinal,
          expectedProjection: expected,
        }),
      });
      resetEntries = staged.entries;
    }
    const current = applyProjectionEvent(previous, event, {
      ...(resetEntries ? { resetEntries } : {}),
    });
    const turnSummaries = stageTurnSummaries(record.turnSummaries, previous, current, event);
    if (event.kind === 'terminal') validateTerminalFrontier(event, current, turnSummaries);
    await this.#apply({ event, previous, current });
    if (event.kind === 'reset') rememberSuperseded(record, previous.checkpoint.projection.epoch);
    record.materialization = current;
    record.turnSummaries.clear();
    for (const [key, summary] of turnSummaries) record.turnSummaries.set(key, summary);
    record.proofs.set(proofKey(event.checkpoint), event);
    await this.#commitOffset(record).catch(() => this.#scheduleOffsetCommit(record));
  }

  async #commitOffset(record: IngressRecord): Promise<void> {
    const applied = record.materialization.checkpoint;
    await record.integration.transcript.commitOffset({
      chat: record.chat,
      signal: AbortSignal.any([
        record.closeController.signal,
        AbortSignal.timeout(10_000),
      ]),
      commit: {
        chatId: record.chat.chatId,
        agentOwnershipEpoch: record.chat.agentOwnershipEpoch,
        applied,
      },
    });
    record.committed = applied;
    pruneProofsThrough(record, applied);
  }

  #scheduleOffsetCommit(record: IngressRecord): void {
    if (record.offsetCommitTask || record.closeController.signal.aborted) return;
    record.offsetCommitTask = (async () => {
      while (!record.closeController.signal.aborted
          && !sameCheckpoint(record.committed, record.materialization.checkpoint)) {
        await abortableDelay(OFFSET_COMMIT_RETRY_MS, record.closeController.signal);
        try {
          await this.#commitOffset(record);
        } catch (error) {
          if (record.closeController.signal.aborted) return;
        }
      }
    })().finally(() => {
      record.offsetCommitTask = null;
      if (!record.closeController.signal.aborted
          && !sameCheckpoint(record.committed, record.materialization.checkpoint)) {
        this.#scheduleOffsetCommit(record);
      }
    });
  }

  #enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.#chains.set(key, next.catch(() => {}));
    return next;
  }
}

type EventRelation = 'settled' | 'duplicate' | 'next' | 'gap' | 'stale' | 'unknown' | 'corrupt';

function classify(record: IngressRecord, event: AgentStreamEvent): EventRelation {
  if (event.checkpoint.projection.epoch === record.committed.projection.epoch
      && compareAgentStreamOffsets(event.checkpoint.offset, record.committed.offset) <= 0) {
    return 'settled';
  }
  const proof = record.proofs.get(proofKey(event.checkpoint));
  if (proof) {
    return proof.digest === event.digest && sameCheckpoint(proof.checkpoint, event.checkpoint)
      ? 'duplicate'
      : 'corrupt';
  }
  if (sameCheckpoint(event.previous, record.materialization.checkpoint)) return 'next';
  if (record.supersededEpochs.has(event.checkpoint.projection.epoch)) return 'stale';
  if (event.previous.projection.epoch === record.materialization.checkpoint.projection.epoch) {
    return 'gap';
  }
  return 'unknown';
}

async function loadCompleteProjection(
  integration: AgentIntegrationV4,
  chat: AgentChatReferenceV4,
  projection: AgentProjectionState,
  signal: AbortSignal,
): Promise<readonly AgentTranscriptEntry[] | Exclude<AgentTranscriptPageResultV4, { readonly kind: 'ready' }>> {
  const pages: (readonly AgentTranscriptEntry[])[] = [];
  let beforeOrdinal: number | null = null;
  let expectedEnd = projection.total + 1;
  do {
    const result = await integration.transcript.loadPage({
      chat,
      signal,
      limit: PAGE_SIZE,
      beforeOrdinal,
      expectedProjection: projection,
    });
    if (result.kind !== 'ready') return result;
    const page = result.page;
    if (!sameProjectionState(page.projection, projection)
        || page.firstOrdinal + page.entries.length !== expectedEnd) {
      return { kind: 'degraded', errorCode: 'PROJECTION_PAGE_GAP', retryable: true };
    }
    pages.push(page.entries);
    beforeOrdinal = page.firstOrdinal;
    expectedEnd = page.firstOrdinal;
    if (!page.hasMore) break;
  } while (expectedEnd > 1);
  if (expectedEnd !== 1) {
    return { kind: 'degraded', errorCode: 'PROJECTION_PAGE_INCOMPLETE', retryable: true };
  }
  return pages.reverse().flat();
}

function rememberSuperseded(record: IngressRecord, epoch: string): void {
  record.supersededEpochs.add(epoch);
  while (record.supersededEpochs.size > SUPERSEDED_EPOCH_LIMIT) {
    const oldest = record.supersededEpochs.values().next().value;
    if (oldest === undefined) return;
    record.supersededEpochs.delete(oldest);
  }
}

function assertCheckpointOwnership(
  checkpoint: AgentStreamCheckpoint,
  chat: AgentChatReferenceV4,
): void {
  if (checkpoint.chatId !== chat.chatId
      || checkpoint.agentOwnershipEpoch !== chat.agentOwnershipEpoch) {
    throw new TypeError('Projection checkpoint ownership mismatch');
  }
}

function proofKey(checkpoint: AgentStreamCheckpoint): string {
  return `${checkpoint.projection.epoch}:${checkpoint.offset}`;
}

function eventKey(event: Pick<AgentStreamEvent, 'chatId' | 'agentOwnershipEpoch'>): string {
  return `${event.chatId.length}:${event.chatId}${event.agentOwnershipEpoch}`;
}

function segmentKey(chat: Pick<AgentChatReferenceV4, 'chatId' | 'agentOwnershipEpoch'>): string {
  return `${chat.chatId.length}:${chat.chatId}${chat.agentOwnershipEpoch}`;
}

function stageTurnSummaries(
  current: ReadonlyMap<string, TurnProjectionSummary>,
  previous: AgentProjectionMaterialization,
  next: AgentProjectionMaterialization,
  event: AgentStreamEvent,
): Map<string, TurnProjectionSummary> {
  if (event.kind === 'reset' && event.reason !== 'input-not-sent') {
    return summariesFromEntries(next.entries, next.agentOwnershipEpoch);
  }
  const staged = cloneTurnSummaries(current);
  if (event.kind === 'commit') {
    for (const promotion of event.promoted) {
      for (const summary of staged.values()) {
        if (summary.entryLifetimeById.has(promotion.entryId)) {
          summary.entryLifetimeById.set(promotion.entryId, 'durable');
          break;
        }
      }
    }
    const firstOrdinal = previous.entries.length + 1;
    event.appended.forEach((entry, index) => {
      addEntryToSummary(staged, entry, firstOrdinal + index, next.agentOwnershipEpoch);
    });
  } else if (event.kind === 'reset') {
    const removed = previous.entries.at(-1);
    if (!removed?.provenance) throw new TypeError('input-not-sent reset lost admission provenance');
    const key = turnOwnerKey(removed.provenance.turnOwner);
    const summary = staged.get(key);
    if (!summary || !summary.entryLifetimeById.delete(removed.id)) {
      throw new TypeError('input-not-sent reset cannot resolve its admitted entry');
    }
    summary.attributableEntryCount -= 1;
    const acceptedIndex = summary.acceptedInputEntryIds.indexOf(removed.id);
    if (acceptedIndex < 0) throw new TypeError('input-not-sent reset removed a non-admission entry');
    summary.acceptedInputEntryIds.splice(acceptedIndex, 1);
  }
  return staged;
}

function summariesFromEntries(
  entries: readonly AgentTranscriptEntry[],
  ownershipEpoch: string,
): Map<string, TurnProjectionSummary> {
  const summaries = new Map<string, TurnProjectionSummary>();
  entries.forEach((entry, index) => addEntryToSummary(summaries, entry, index + 1, ownershipEpoch));
  return summaries;
}

function addEntryToSummary(
  summaries: Map<string, TurnProjectionSummary>,
  entry: AgentTranscriptEntry,
  _ordinal: number,
  ownershipEpoch: string,
): void {
  const provenance = entry.provenance;
  if (!provenance) return;
  if (provenance.agentOwnershipEpoch !== ownershipEpoch
      || provenance.turnOwner.agentOwnershipEpoch !== ownershipEpoch) {
    throw new TypeError('Transcript provenance uses a stale ownership epoch');
  }
  for (const existing of summaries.values()) {
    if (existing.owner.turnId === provenance.turnOwner.turnId
        && !sameTurnOwner(existing.owner, provenance.turnOwner)) {
      throw new TypeError('One turn cannot have multiple receipt owners');
    }
  }
  const key = turnOwnerKey(provenance.turnOwner);
  let summary = summaries.get(key);
  if (!summary) {
    summary = {
      owner: { ...provenance.turnOwner },
      attributableEntryCount: 0,
      acceptedInputEntryIds: [],
      entryLifetimeById: new Map(),
    };
    summaries.set(key, summary);
  }
  if (summary.entryLifetimeById.has(entry.id)) {
    throw new TypeError('Turn summary received a duplicate transcript entry');
  }
  summary.attributableEntryCount += 1;
  summary.entryLifetimeById.set(entry.id, entry.lifetime);
  if (entry.message.type === 'user-message'
      && (entry.lifetime === 'active' || entry.source?.namespace === 'garcon:admission')) {
    summary.acceptedInputEntryIds.push(entry.id);
  }
}

function validateTerminalFrontier(
  event: Extract<AgentStreamEvent, { readonly kind: 'terminal' }>,
  materialization: AgentProjectionMaterialization,
  summaries: ReadonlyMap<string, TurnProjectionSummary>,
): void {
  const owner = event.operation.turnOwner;
  if (!sameTurnOwner(owner, {
    agentOwnershipEpoch: event.operation.agentOwnershipEpoch,
    commandType: event.operation.commandType,
    clientRequestId: event.operation.clientRequestId,
    turnId: event.operation.turnId,
  })) {
    throw new TypeError('Terminal operation does not identify its immutable receipt owner');
  }
  const summary = summaries.get(turnOwnerKey(owner));
  if (!summary) throw new TypeError('Terminal has no attributable projection summary');
  if (summary.attributableEntryCount !== event.completeness.attributableEntryCount) {
    throw new TypeError('Terminal attributable entry count is incomplete');
  }
  const accepted = event.completeness.acceptedInputEntryIds;
  if (new Set(accepted).size !== accepted.length
      || accepted.length !== summary.acceptedInputEntryIds.length
      || accepted.some((entryId, index) => entryId !== summary.acceptedInputEntryIds[index])) {
    throw new TypeError('Terminal accepted input frontier is incomplete');
  }
  if (event.outcome.kind !== 'finished') return;
  if (event.sourceSettlement !== 'confirmed'
      || materialization.checkpoint.projection.durableCount
        !== materialization.checkpoint.projection.total
      || summary.acceptedInputEntryIds.some((entryId) => (
        summary.entryLifetimeById.get(entryId) !== 'durable'
      ))) {
    throw new TypeError('Successful terminal is not fully durable and settled');
  }
}

function cloneTurnSummaries(
  summaries: ReadonlyMap<string, TurnProjectionSummary>,
): Map<string, TurnProjectionSummary> {
  return new Map([...summaries].map(([key, summary]) => [key, {
    owner: { ...summary.owner },
    attributableEntryCount: summary.attributableEntryCount,
    acceptedInputEntryIds: [...summary.acceptedInputEntryIds],
    entryLifetimeById: new Map(summary.entryLifetimeById),
  }]));
}

function sameTurnOwner(left: AgentTurnReceiptOwner, right: AgentTurnReceiptOwner): boolean {
  return left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.commandType === right.commandType
    && left.clientRequestId === right.clientRequestId
    && left.turnId === right.turnId;
}

function turnOwnerKey(owner: AgentTurnReceiptOwner): string {
  return JSON.stringify([
    owner.agentOwnershipEpoch,
    owner.commandType,
    owner.clientRequestId,
    owner.turnId,
  ]);
}

function pruneProofsThrough(record: IngressRecord, applied: AgentStreamCheckpoint): void {
  const target = proofKey(applied);
  for (const key of record.proofs.keys()) {
    record.proofs.delete(key);
    if (key === target) break;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
