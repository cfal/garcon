import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Database } from 'bun:sqlite';
import {
  type AgentLogger,
  type AgentTranscriptIndexFailure,
  type AgentTranscriptIndexerModule,
  type AgentTranscriptIndexSource,
} from '@garcon/server-agent-interface';
import { isEmbeddedStandaloneEntrypoint } from '../build/standalone-entrypoint.js';
import { canonicalDigest } from './digest.js';
import { TRANSCRIPT_SEARCH_PROJECTOR_VERSION } from './message-projector.js';
import {
  closeSearchDatabase,
  deleteChatRows,
  getChatSafetyStates,
  getChatState,
  markChatAttempt,
  openSearchDatabase,
  prepareChatBuild,
  pruneMissingChats,
  runIdleMaintenance,
  sealChatFromStaging,
  stageChatRows,
} from './schema.js';
import {
  catalogEntryKey,
  rowsForBatch,
  stripFirstUserSeedPreservingSource,
  TRANSCRIPT_INDEX_LOAD_LIMITS,
  validateCatalogEntry,
  validateNativeBatch,
} from './indexer-job-data.js';
import { IndexerCarryOverStream, IndexerCatalogFrames } from './indexer-protocol-streams.js';
import type {
  IndexerEvent,
  IndexerRequest,
  TranscriptIndexModuleRegistration,
} from './worker-protocol.js';
import { compareGeneration } from './worker-protocol.js';
import type { TranscriptSearchCatalogEntry } from './transcript-search-service.js';

type CatalogWork = TranscriptSearchCatalogEntry & {
  generation: { readonly epoch: string; readonly sequence: number };
};

type QueueReason = 'catalog' | 'dirty' | 'retry' | 'safety';

interface QueuedWork {
  readonly chatId: string;
  readonly agentId: string;
  readonly reason: QueueReason;
  readonly token: number;
  readonly enqueuedAt: number;
}

const DIRTY_DEBOUNCE_MS = 100;
const DIRTY_REVISION_RETRY_MS = [1_000, 5_000, 30_000] as const;
const FAILURE_RETRY_MS = [5_000, 30_000, 5 * 60_000] as const;
const SAFETY_SWEEP_INTERVAL_MS = 60_000;
const IDLE_MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const REVISIONED_SAFETY_AGE_MS = 5 * 60_000;
const NULL_PROBE_SAFETY_AGE_MS = 30 * 60_000;
const SAFETY_SLICE_LIMIT = 8;
const BACKGROUND_DUTY_CYCLE = 0.3;

let db: Database | null = null;
let lifecycleEpoch = '';
let operationEpoch = '';
let scratchDirectory = '';
let closing = false;
let newestCatalogSequence = 0;
const registrations = new Map<string, TranscriptIndexModuleRegistration>();
const instances = new Map<string, AgentTranscriptIndexSource>();
const catalog = new Map<string, CatalogWork>();
const agentQueues = new Map<string, QueuedWork[]>();
const agentOrder: string[] = [];
const queued = new Map<string, QueuedWork>();
const activeBuilds = new Map<string, AbortController>();
const dirtyGenerations = new Map<string, CatalogWork['generation']>();
const deleteTombstones = new Map<string, CatalogWork['generation']>();
const dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dirtyRevisionAttempts = new Map<string, { generation: CatalogWork['generation']; count: number }>();
const nullProbeAttempts = new Map<string, CatalogWork['generation']>();
const failureAttempts = new Map<string, { generation: CatalogWork['generation']; count: number }>();
const safetyCheckedAt = new Map<string, number>();
const quarantines = new Map<string, string>();
let draining = false;
let queueToken = 0;
let agentCursor = 0;
let safetyTimer: ReturnType<typeof setInterval> | null = null;
let schedulerPauseCancel: (() => void) | null = null;
let lastIdleMaintenanceAt = 0;

function post(message: IndexerEvent): void {
  self.postMessage(message);
}

const catalogFrames = new IndexerCatalogFrames(post);
const carryOverStream = new IndexerCarryOverStream(post, () => lifecycleEpoch);

function response(request: IndexerRequest) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function requireDb(): Database {
  if (!db || closing) throw new Error('Transcript indexer is not open');
  return db;
}

function generationCurrent(entry: CatalogWork): boolean {
  const tombstone = deleteTombstones.get(entry.chatId);
  return catalog.get(entry.chatId) === entry
    && (!tombstone || (compareGeneration(entry.generation, tombstone) ?? -1) > 0)
    && !closing;
}

function sanitizedFailure(error: unknown): AgentTranscriptIndexFailure {
  const candidate = error && typeof error === 'object'
    ? (error as { failure?: Partial<AgentTranscriptIndexFailure> }).failure
    : null;
  if (candidate?.kind === 'agent-transcript-index-failure'
      && typeof candidate.code === 'string'
      && /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.code)
      && typeof candidate.retryable === 'boolean'
      && typeof candidate.refreshSource === 'boolean') {
    return candidate as AgentTranscriptIndexFailure;
  }
  return {
    kind: 'agent-transcript-index-failure',
    code: 'SOURCE_INTERNAL',
    retryable: false,
    refreshSource: false,
  };
}

function isSqliteFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return error.name === 'SQLiteError'
    || (typeof code === 'string' && code.startsWith('SQLITE_'));
}

const logger: AgentLogger = {
  debug(message, fields) { console.debug('[transcript-indexer]', message, fields ?? ''); },
  info(message, fields) { console.info('[transcript-indexer]', message, fields ?? ''); },
  warn(message, fields) { console.warn('[transcript-indexer]', message, fields ?? ''); },
  error(message, fields) { console.error('[transcript-indexer]', message, fields ?? ''); },
};

async function loadProvider(agentId: string): Promise<AgentTranscriptIndexSource> {
  const existing = instances.get(agentId);
  if (existing) return existing;
  const registration = registrations.get(agentId);
  if (!registration) throw new Error('Transcript index module is not registered');
  const imported = await import(registration.moduleUrl) as { default?: unknown };
  const module = imported.default as Partial<AgentTranscriptIndexerModule> | undefined;
  if (!module
      || module.apiVersion !== 1
      || module.integrationId !== agentId
      || typeof module.create !== 'function') {
    throw new Error('Transcript index module contract is invalid');
  }
  const instance = module.create({ agentId, logger });
  if (!instance || typeof instance.probe !== 'function'
      || typeof instance.load !== 'function' || typeof instance.close !== 'function') {
    throw new Error('Transcript index source contract is invalid');
  }
  instances.set(agentId, instance);
  return instance;
}

function queueChat(chatId: string, reason: QueueReason): void {
  const entry = catalog.get(chatId);
  if (!entry || queued.has(chatId) || closing) return;
  if (!agentQueues.has(entry.agentId)) {
    agentQueues.set(entry.agentId, []);
    agentOrder.push(entry.agentId);
  }
  const work = {
    chatId,
    agentId: entry.agentId,
    reason,
    token: ++queueToken,
    enqueuedAt: Date.now(),
  } satisfies QueuedWork;
  queued.set(chatId, work);
  agentQueues.get(entry.agentId)!.push(work);
  void drainQueue();
}

function nextQueuedWork(): QueuedWork | null {
  if (queued.size === 0 || agentOrder.length === 0) return null;
  for (let count = 0; count < agentOrder.length; count += 1) {
    const index = (agentCursor + count) % agentOrder.length;
    const agentId = agentOrder[index];
    const queue = agentQueues.get(agentId);
    while (queue && queue.length > 0) {
      const candidate = queue.shift()!;
      if (queued.get(candidate.chatId)?.token !== candidate.token) continue;
      queued.delete(candidate.chatId);
      agentCursor = (index + 1) % agentOrder.length;
      return candidate;
    }
  }
  return null;
}

function queuedOldestAge(): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const work of queued.values()) oldest = Math.min(oldest, work.enqueuedAt);
  return Number.isFinite(oldest) ? Math.max(0, Date.now() - oldest) : 0;
}

function status() {
  const counts = requireDb().query<{
    indexed: number;
    pending: number;
    failed: number;
    unsupported: number;
  }, []>(`
    SELECT
      COALESCE(SUM(status = 'sealed'), 0) AS indexed,
      COALESCE(SUM(status = 'pending'), 0) AS pending,
      COALESCE(SUM(status = 'failed'), 0) AS failed,
      COALESCE(SUM(status = 'unsupported'), 0) AS unsupported
    FROM search_chat_state
  `).get() ?? { indexed: 0, pending: 0, failed: 0, unsupported: 0 };
  return {
    indexedChatCount: Number(counts.indexed),
    pendingChatCount: Number(counts.pending),
    failedChatCount: Number(counts.failed),
    unsupportedChatCount: Number(counts.unsupported),
  };
}

function emitProgress(): void {
  if (!db || closing) return;
  post({
    type: 'progress',
    lifecycleEpoch,
    status: status(),
    queueDepth: queued.size,
    oldestPendingMs: queuedOldestAge(),
  });
}

function emitSourceStatus(
  entry: CatalogWork,
  generation: CatalogWork['generation'],
  state: 'sealed' | 'pending' | 'failed' | 'unsupported',
  errorCode: string | null,
  retryable: boolean | null,
): void {
  const dirty = dirtyGenerations.get(entry.chatId);
  if (dirty && (compareGeneration(generation, dirty) ?? -1) >= 0
      && (state === 'sealed' || state === 'unsupported'
        || (state === 'failed' && retryable === false))) {
    dirtyGenerations.delete(entry.chatId);
  }
  post({
    type: 'source-status',
    lifecycleEpoch,
    chatId: entry.chatId,
    agentId: entry.agentId,
    generation,
    state,
    errorCode,
    retryable,
  });
}

function newerGeneration(
  left: CatalogWork['generation'],
  right: CatalogWork['generation'],
): CatalogWork['generation'] {
  return (compareGeneration(left, right) ?? -1) >= 0 ? left : right;
}

function attemptGeneration(entry: CatalogWork): CatalogWork['generation'] {
  const dirty = dirtyGenerations.get(entry.chatId);
  return dirty ? newerGeneration(dirty, entry.generation) : entry.generation;
}

function hasPendingDirty(entry: CatalogWork, generation: CatalogWork['generation']): boolean {
  const dirty = dirtyGenerations.get(entry.chatId);
  return Boolean(dirty && (compareGeneration(generation, dirty) ?? -1) >= 0);
}

function scheduleChat(
  entry: CatalogWork,
  generation: CatalogWork['generation'],
  delayMs: number,
  reason: QueueReason,
): void {
  const existing = retryTimers.get(entry.chatId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    retryTimers.delete(entry.chatId);
    const current = catalog.get(entry.chatId);
    if (!current || !generationCurrent(current)) return;
    const newest = attemptGeneration(current);
    if ((compareGeneration(newest, generation) ?? -1) < 0) return;
    queueChat(entry.chatId, reason);
  }, delayMs);
  timer.unref?.();
  retryTimers.set(entry.chatId, timer);
}

function handleUnchangedRevision(
  entry: CatalogWork,
  generation: CatalogWork['generation'],
): boolean {
  if (!hasPendingDirty(entry, generation)) {
    emitSourceStatus(entry, generation, 'sealed', null, null);
    return true;
  }
  const current = dirtyRevisionAttempts.get(entry.chatId);
  const state = current && compareGeneration(current.generation, generation) === 0
    ? current
    : { generation, count: 0 };
  if (state.count >= DIRTY_REVISION_RETRY_MS.length) {
    dirtyRevisionAttempts.delete(entry.chatId);
    emitSourceStatus(entry, generation, 'sealed', null, null);
    return true;
  }
  const delay = DIRTY_REVISION_RETRY_MS[state.count];
  dirtyRevisionAttempts.set(entry.chatId, { generation, count: state.count + 1 });
  scheduleChat(entry, generation, delay, 'dirty');
  return true;
}

function handleUnchangedNullProbe(
  entry: CatalogWork,
  generation: CatalogWork['generation'],
): void {
  if (!hasPendingDirty(entry, generation)) {
    emitSourceStatus(entry, generation, 'sealed', null, null);
    return;
  }
  const previous = nullProbeAttempts.get(entry.chatId);
  if (previous && compareGeneration(previous, generation) === 0) {
    nullProbeAttempts.delete(entry.chatId);
    emitSourceStatus(entry, generation, 'sealed', null, null);
    return;
  }
  nullProbeAttempts.set(entry.chatId, generation);
  scheduleChat(entry, generation, 30_000, 'dirty');
}

function resetRetryState(chatId: string): void {
  failureAttempts.delete(chatId);
  dirtyRevisionAttempts.delete(chatId);
  nullProbeAttempts.delete(chatId);
  const timer = retryTimers.get(chatId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(chatId);
}

function scheduleFailureRetry(
  entry: CatalogWork,
  generation: CatalogWork['generation'],
): number {
  const current = failureAttempts.get(entry.chatId);
  const state = current && compareGeneration(current.generation, generation) === 0
    ? current
    : { generation, count: 0 };
  const delay = FAILURE_RETRY_MS[Math.min(state.count, FAILURE_RETRY_MS.length - 1)];
  failureAttempts.set(entry.chatId, { generation, count: state.count + 1 });
  scheduleChat(entry, generation, delay, 'retry');
  return delay;
}

function runSafetySweep(): void {
  if (closing || draining || queued.size > 0) return;
  const now = Date.now();
  const persisted = getChatSafetyStates(requireDb());
  const checkedAt = (chatId: string): number => {
    const memory = safetyCheckedAt.get(chatId);
    if (memory !== undefined) return memory;
    const value = persisted.get(chatId)?.lastCheckedAt;
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const candidates = [...catalog.values()]
    .filter((entry) => entry.source.state !== 'failed')
    .sort((left, right) => {
      const leftAge = checkedAt(left.chatId);
      const rightAge = checkedAt(right.chatId);
      return leftAge - rightAge || left.agentId.localeCompare(right.agentId)
        || left.chatId.localeCompare(right.chatId);
    });
  let queuedCount = 0;
  for (const entry of candidates) {
    if (queuedCount >= SAFETY_SLICE_LIMIT) break;
    const minimumAge = persisted.get(entry.chatId)?.sourceRevision === null
      ? NULL_PROBE_SAFETY_AGE_MS
      : REVISIONED_SAFETY_AGE_MS;
    if (now - checkedAt(entry.chatId) < minimumAge) continue;
    safetyCheckedAt.set(entry.chatId, now);
    queueChat(entry.chatId, 'safety');
    queuedCount += 1;
  }
}

async function yieldForBackgroundDuty(startedAt: number): Promise<void> {
  const activeMs = Math.max(0.1, performance.now() - startedAt);
  const pauseMs = Math.min(250, activeMs * ((1 / BACKGROUND_DUTY_CYCLE) - 1));
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (schedulerPauseCancel === finish) schedulerPauseCancel = null;
      resolve();
    };
    const timer = setTimeout(finish, pauseMs);
    timer.unref?.();
    schedulerPauseCancel = finish;
  });
}

async function buildChat(entry: CatalogWork, work: QueuedWork): Promise<void> {
  const controller = new AbortController();
  activeBuilds.set(entry.chatId, controller);
  const generation = attemptGeneration(entry);
  const source = entry.source.state === 'ready' ? entry.source.reference : null;
  const descriptorHash = source ? canonicalDigest(source) : null;
  const moduleApiVersion = registrations.get(entry.agentId)?.apiVersion ?? 1;
  let provider: AgentTranscriptIndexSource | null = null;
  let sourceRevision: string | null = null;
  let jobSignature: string | null = null;
  const attemptBase = {
    chatId: entry.chatId,
    agentId: entry.agentId,
    model: entry.model,
    sourceApiVersion: moduleApiVersion,
    projectorVersion: TRANSCRIPT_SEARCH_PROJECTOR_VERSION,
    sourceDescriptorHash: descriptorHash,
    sourceRevision,
    carryOverRevision: entry.carryOverRevision,
    operationEpoch: generation.epoch,
    operationSequence: generation.sequence,
  };
  try {
    if (entry.source.state === 'failed') {
      markChatAttempt(requireDb(), attemptBase, 'failed', entry.source.code);
      emitSourceStatus(
        entry,
        generation,
        'failed',
        entry.source.code,
        entry.source.retryable,
      );
      return;
    }
    if (source) {
      if (source.ownerId !== entry.agentId) throw new Error('SOURCE_OWNER_MISMATCH');
      provider = await loadProvider(entry.agentId);
      sourceRevision = (await provider.probe(source, controller.signal)).revision;
    }
    if (!generationCurrent(entry)) return;
    jobSignature = canonicalDigest({
      agentId: entry.agentId,
      model: entry.model,
      sourceDescriptorHash: descriptorHash,
      sourceRevision: sourceRevision ?? `generation:${generation.sequence}`,
      carryOverRevision: entry.carryOverRevision,
    });
    post({
      type: 'job-state',
      lifecycleEpoch,
      state: 'started',
      chatId: entry.chatId,
      sourceSignature: jobSignature,
    });
    const quarantinedSignature = quarantines.get(entry.chatId);
    if (quarantinedSignature === jobSignature) {
      markChatAttempt(requireDb(), { ...attemptBase, sourceRevision }, 'failed', 'SOURCE_QUARANTINED');
      emitSourceStatus(entry, generation, 'failed', 'SOURCE_QUARANTINED', false);
      return;
    }
    if (quarantinedSignature) quarantines.delete(entry.chatId);
    const previous = getChatState(requireDb(), entry.chatId);
    const unchanged = previous?.status === 'sealed'
      && previous.agentId === entry.agentId
      && previous.model === entry.model
      && previous.sourceDescriptorHash === descriptorHash
      && previous.sourceRevision === sourceRevision
      && previous.carryOverRevision === entry.carryOverRevision
      && sourceRevision !== null;
    safetyCheckedAt.set(entry.chatId, Date.now());
    if (unchanged) {
      handleUnchangedRevision(entry, generation);
      return;
    }

    const attempt = { ...attemptBase, sourceRevision };
    markChatAttempt(requireDb(), attempt, 'pending');
    emitSourceStatus(entry, generation, 'pending', null, null);
    prepareChatBuild(requireDb());
    const ordinal = { value: 0 };
    const content = createHash('sha256');
    let rowCount = 0;
    let carriedMessages = 0;
    for await (const batch of carryOverStream.batches(entry, controller.signal)) {
      const batchStartedAt = performance.now();
      if (!generationCurrent(entry)) throw new DOMException('Superseded', 'AbortError');
      carriedMessages += batch.length;
      const rows = rowsForBatch(batch, ordinal, content);
      rowCount += rows.length;
      if (rows.length > 0) stageChatRows(requireDb(), rows);
      await yieldForBackgroundDuty(batchStartedAt);
    }

    if (source && provider) {
      let seedHandled = carriedMessages === 0;
      for await (const rawBatch of provider.load({
        source,
        signal: controller.signal,
        limits: TRANSCRIPT_INDEX_LOAD_LIMITS,
        scratchDirectory,
      })) {
        const batchStartedAt = performance.now();
        if (!generationCurrent(entry)) throw new DOMException('Superseded', 'AbortError');
        let batch = validateNativeBatch(rawBatch);
        if (!seedHandled) {
          const firstUser = batch.some((message) => message.type === 'user-message');
          batch = stripFirstUserSeedPreservingSource(batch);
          seedHandled = firstUser;
        }
        const rows = rowsForBatch(batch, ordinal, content);
        rowCount += rows.length;
        if (rows.length > 0) stageChatRows(requireDb(), rows);
        await yieldForBackgroundDuty(batchStartedAt);
      }
      const afterRevision = (await provider.probe(source, controller.signal)).revision;
      if (sourceRevision !== afterRevision) throw new Error('SOURCE_CHANGED');
    }
    if (!generationCurrent(entry)) return;
    const contentDigest = content.digest('hex');
    const sealedSourceKey = canonicalDigest({
      schemaVersion: 4,
      projectorVersion: TRANSCRIPT_SEARCH_PROJECTOR_VERSION,
      sourceApiVersion: moduleApiVersion,
      agentId: entry.agentId,
      model: entry.model,
      descriptorHash,
      sourceRevision,
      carryOverRevision: entry.carryOverRevision,
      contentDigest,
    });
    if (rowCount === 0) {
      sealChatFromStaging(requireDb(), {
        ...attempt,
        contentDigest,
        sealedSourceKey,
        messageCount: 0,
      });
      requireDb().query(`
        UPDATE search_chat_state SET status = 'unsupported' WHERE chat_id = ?
      `).run(entry.chatId);
      resetRetryState(entry.chatId);
      emitSourceStatus(entry, generation, 'unsupported', null, null);
      return;
    }
    if (previous?.sealedSourceKey === sealedSourceKey) {
      markChatAttempt(requireDb(), attempt, 'pending');
      // The rows remain sealed; a same-content null probe requires no replacement.
      requireDb().query(`
        UPDATE search_chat_state SET status = 'sealed', last_error_code = NULL,
          operation_epoch = ?, operation_sequence = ?, last_checked_at = ?, updated_at = ?
        WHERE chat_id = ?
      `).run(generation.epoch, generation.sequence, new Date().toISOString(), new Date().toISOString(), entry.chatId);
      if (sourceRevision === null && work.reason !== 'safety') {
        handleUnchangedNullProbe(entry, generation);
      } else {
        resetRetryState(entry.chatId);
        emitSourceStatus(entry, generation, 'sealed', null, null);
      }
      return;
    }
    sealChatFromStaging(requireDb(), {
      ...attempt,
      contentDigest,
      sealedSourceKey,
      messageCount: rowCount,
    });
    resetRetryState(entry.chatId);
    emitSourceStatus(entry, generation, 'sealed', null, null);
  } catch (error) {
    if (controller.signal.aborted || !generationCurrent(entry)) return;
    if (isSqliteFailure(error)) {
      closing = true;
      post({ type: 'fatal', lifecycleEpoch, code: 'INDEX_STORAGE_FAILED' });
      return;
    }
    const failure = sanitizedFailure(error);
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
      ? error.message
      : failure.code;
    const retryable = failure.retryable
      || code === 'SOURCE_CHANGED'
      || code === 'CARRY_OVER_TIMEOUT'
      || code === 'CARRY_OVER_REVISION_CHANGED';
    markChatAttempt(requireDb(), { ...attemptBase, sourceRevision }, 'failed', code);
    emitSourceStatus(entry, generation, 'failed', code, retryable);
    if (retryable) {
      const retryAfterMs = code === 'SOURCE_CHANGED'
        ? 1_000
        : scheduleFailureRetry(entry, generation);
      if (code === 'SOURCE_CHANGED') scheduleChat(entry, generation, retryAfterMs, 'retry');
      if (failure.refreshSource && descriptorHash) {
        post({
          type: 'refresh-source-reference',
          lifecycleEpoch,
          chatId: entry.chatId,
          agentId: entry.agentId,
          generation,
          sourceDescriptorHash: descriptorHash,
          reasonCode: code,
          retryAfterMs,
        });
      }
    } else {
      resetRetryState(entry.chatId);
    }
  } finally {
    if (activeBuilds.get(entry.chatId) === controller) activeBuilds.delete(entry.chatId);
    if (jobSignature) post({
      type: 'job-state',
      lifecycleEpoch,
      state: 'finished',
      chatId: entry.chatId,
      sourceSignature: jobSignature,
    });
    emitProgress();
  }
}

async function drainQueue(): Promise<void> {
  if (draining || closing) return;
  draining = true;
  try {
    while (queued.size > 0 && !closing) {
      const work = nextQueuedWork();
      if (!work) break;
      const entry = catalog.get(work.chatId);
      if (entry && entry.agentId === work.agentId) await buildChat(entry, work);
    }
  } finally {
    draining = false;
    if (!closing && queued.size === 0
        && Date.now() - lastIdleMaintenanceAt >= IDLE_MAINTENANCE_INTERVAL_MS) {
      try {
        runIdleMaintenance(requireDb());
        lastIdleMaintenanceAt = Date.now();
      } catch {
        closing = true;
        post({ type: 'fatal', lifecycleEpoch, code: 'INDEX_STORAGE_FAILED' });
      }
    }
  }
}

export async function handleIndexerRequest(request: IndexerRequest): Promise<void> {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  if (request.type !== 'carry-over-chunk') schedulerPauseCancel?.();
  try {
    switch (request.type) {
      case 'open': {
        lifecycleEpoch = request.lifecycleEpoch;
        operationEpoch = request.operationEpoch;
        scratchDirectory = request.scratchDirectory;
        await fs.rm(scratchDirectory, { recursive: true, force: true });
        await fs.mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
        for (const registration of request.modules) {
          if (registration.agentId.length === 0 || registration.apiVersion !== 1) {
            throw new Error('INVALID_MODULE_REGISTRATION');
          }
          if (registrations.has(registration.agentId)) throw new Error('DUPLICATE_MODULE_REGISTRATION');
          const modulePath = registration.moduleUrl.startsWith('file:')
            ? fileURLToPath(registration.moduleUrl)
            : registration.moduleUrl;
          if (!isEmbeddedStandaloneEntrypoint(modulePath)) await fs.access(modulePath);
          registrations.set(registration.agentId, registration);
        }
        for (const quarantine of request.quarantines) {
          if (!quarantine || typeof quarantine.chatId !== 'string' || quarantine.chatId.length === 0
              || typeof quarantine.sourceSignature !== 'string'
              || !/^[a-f0-9]{64}$/.test(quarantine.sourceSignature)
              || quarantines.has(quarantine.chatId)) {
            throw new Error('INVALID_QUARANTINE_REGISTRATION');
          }
          quarantines.set(quarantine.chatId, quarantine.sourceSignature);
        }
        db = (await openSearchDatabase(request.dbPath)).db;
        safetyTimer = setInterval(runSafetySweep, SAFETY_SWEEP_INTERVAL_MS);
        safetyTimer.unref?.();
        post({ type: 'opened', ...response(request) });
        emitProgress();
        return;
      }
      case 'catalog-chunk': {
        const snapshot = catalogFrames.accept(request);
        if (!snapshot) return;
        if (snapshot.generation.epoch !== operationEpoch
            || snapshot.generation.sequence < newestCatalogSequence) {
          post({ type: 'ack', ...response(request) });
          return;
        }
        newestCatalogSequence = snapshot.generation.sequence;
        const next = new Map<string, CatalogWork>();
        const changed = new Set<string>();
        const seenChatIds = new Set<string>();
        for (const entry of snapshot.chats) {
          validateCatalogEntry(entry);
          if (seenChatIds.has(entry.chatId) || !registrations.has(entry.agentId)) {
            throw new Error('INVALID_CATALOG_ENTRY');
          }
          seenChatIds.add(entry.chatId);
          const tombstone = deleteTombstones.get(entry.chatId);
          const tombstoneOrdering = tombstone
            ? compareGeneration(snapshot.generation, tombstone)
            : null;
          if (tombstone && (tombstoneOrdering ?? -1) <= 0) continue;
          if (tombstone) deleteTombstones.delete(entry.chatId);
          const previous = catalog.get(entry.chatId);
          if (previous && catalogEntryKey(previous) === catalogEntryKey(entry)) {
            previous.generation = snapshot.generation;
            next.set(entry.chatId, previous);
          } else {
            next.set(entry.chatId, { ...entry, generation: snapshot.generation });
            changed.add(entry.chatId);
          }
        }
        for (const [chatId, tombstone] of deleteTombstones) {
          const ordering = compareGeneration(snapshot.generation, tombstone);
          if (ordering !== null && ordering > 0 && !next.has(chatId)) {
            deleteTombstones.delete(chatId);
          }
        }
        for (const [chatId, active] of activeBuilds) {
          if (!next.has(chatId) || changed.has(chatId)) active.abort();
        }
        for (const chatId of queued.keys()) {
          if (!next.has(chatId) || changed.has(chatId)) queued.delete(chatId);
        }
        catalog.clear();
        for (const [chatId, entry] of next) catalog.set(chatId, entry);
        pruneMissingChats(requireDb(), [...catalog.keys()]);
        for (const chatId of catalog.keys()) {
          if (changed.has(chatId) || dirtyGenerations.has(chatId)) queueChat(chatId, 'catalog');
        }
        post({ type: 'ack', ...response(request) });
        emitProgress();
        return;
      }
      case 'source-dirty': {
        const tombstone = deleteTombstones.get(request.chatId);
        const current = dirtyGenerations.get(request.chatId);
        if (request.generation.epoch === operationEpoch
            && (!tombstone || (compareGeneration(request.generation, tombstone) ?? -1) > 0)
            && (!current || (compareGeneration(request.generation, current) ?? -1) > 0)) {
          dirtyGenerations.set(request.chatId, request.generation);
          dirtyRevisionAttempts.delete(request.chatId);
          nullProbeAttempts.delete(request.chatId);
          const existing = dirtyTimers.get(request.chatId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            dirtyTimers.delete(request.chatId);
            queueChat(request.chatId, 'dirty');
          }, DIRTY_DEBOUNCE_MS);
          timer.unref?.();
          dirtyTimers.set(request.chatId, timer);
        }
        post({ type: 'ack', ...response(request) });
        return;
      }
      case 'delete-chat': {
        if (request.generation.epoch !== operationEpoch) {
          post({ type: 'ack', ...response(request) });
          return;
        }
        const catalogGeneration = catalog.get(request.chatId)?.generation;
        const currentTombstone = deleteTombstones.get(request.chatId);
        const newest = [catalogGeneration, currentTombstone, dirtyGenerations.get(request.chatId)]
          .filter((value): value is CatalogWork['generation'] => Boolean(value))
          .reduce<CatalogWork['generation'] | null>(
            (latest, value) => latest ? newerGeneration(latest, value) : value,
            null,
          );
        if (newest && (compareGeneration(request.generation, newest) ?? -1) < 0) {
          post({ type: 'ack', ...response(request) });
          return;
        }
        deleteTombstones.set(request.chatId, request.generation);
        activeBuilds.get(request.chatId)?.abort();
        catalog.delete(request.chatId);
        queued.delete(request.chatId);
        dirtyGenerations.delete(request.chatId);
        resetRetryState(request.chatId);
        const dirtyTimer = dirtyTimers.get(request.chatId);
        if (dirtyTimer) clearTimeout(dirtyTimer);
        dirtyTimers.delete(request.chatId);
        deleteChatRows(requireDb(), request.chatId);
        post({ type: 'ack', ...response(request) });
        emitProgress();
        return;
      }
      case 'carry-over-chunk': {
        carryOverStream.accept(request);
        return;
      }
      case 'close': {
        closing = true;
        if (safetyTimer) clearInterval(safetyTimer);
        safetyTimer = null;
        for (const timer of dirtyTimers.values()) clearTimeout(timer);
        for (const timer of retryTimers.values()) clearTimeout(timer);
        dirtyTimers.clear();
        retryTimers.clear();
        for (const active of activeBuilds.values()) active.abort();
        carryOverStream.cancelAll();
        catalogFrames.clear();
        await Promise.allSettled([...instances.values()].reverse().map((instance) => instance.close()));
        instances.clear();
        const activeDb = db;
        db = null;
        if (activeDb) closeSearchDatabase(activeDb);
        await fs.rm(scratchDirectory, { recursive: true, force: true });
        post({ type: 'closed', ...response(request) });
        self.close();
        return;
      }
    }
  } catch (error) {
    if (request.type === 'catalog-chunk') catalogFrames.discard(request.requestId);
    post({
      type: 'error',
      ...response(request),
      code: error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
        ? error.message
        : 'INDEXER_INTERNAL',
      retryable: request.type !== 'open',
    });
  }
}
