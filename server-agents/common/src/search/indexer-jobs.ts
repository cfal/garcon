import type { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import {
  activateChat,
  advanceFrontier,
  buildTermStep,
  cleanupStep,
  closeSearchDatabase,
  completeReplacementCheckpoint,
  markChatFailed,
  markPrunedChats,
  observeWal,
  openSearchDatabase,
  planAppend,
  planReplacement,
  readActiveChunkBody,
  stageRawChunks,
  startRemoval,
  truncateWal,
  type SearchChatState,
  type SyncPlanResult,
  type WalCheckpointStatus,
} from './schema.js';
import { SearchTokenizer } from './tokenizer.js';
import type {
  IndexerEvent,
  IndexerPhysicalStep,
  IndexerRequest,
  PhysicalStepResult,
  RequestIdentity,
  WalObservation,
} from './worker-protocol.js';
import {
  isIndexerEvent,
  isIndexerWalAuthoritativeErrorCode,
} from './worker-protocol.js';

let db: Database | null = null;
let dbPath: string | null = null;
let tokenizer: SearchTokenizer | null = null;
let lifecycleEpoch = '';
let walEpoch = 0;
let walObservationSequence = 0;
let activeGrantId: number | null = null;
let closing = false;
let walFenced = false;

function post(message: IndexerEvent): void {
  if (!isIndexerEvent(message)) throw new Error('INDEXER_EVENT_INVALID');
  self.postMessage(message);
}

function identity(request: RequestIdentity): RequestIdentity {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

function requireDb(): Database {
  if (!db || closing) throw new Error('INDEXER_UNAVAILABLE');
  return db;
}

function requireTokenizer(): SearchTokenizer {
  if (!tokenizer || closing) throw new Error('INDEXER_UNAVAILABLE');
  return tokenizer;
}

function explicitErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : 'INDEXER_INTERNAL';
}

function retryableError(code: string): boolean {
  return code === 'INDEXER_INTERNAL'
    || code === 'INDEXER_UNAVAILABLE'
    || code === 'SEARCH_WAL_MAINTENANCE_REQUIRED';
}

function knownOutcomeErrorCode(error: unknown): string | null {
  const code = explicitErrorCode(error);
  return isIndexerWalAuthoritativeErrorCode(code) ? code : null;
}

function walObservation(status: WalCheckpointStatus): WalObservation {
  walObservationSequence += 1;
  return {
    walEpoch,
    walObservationSequence,
    logFrames: status.logFrames,
    checkpointedFrames: status.checkpointedFrames,
  };
}

function observeForEvent(): WalObservation {
  return walObservation(observeWal(requireDb()));
}

function closeResources(): void {
  const priorTokenizer = tokenizer;
  const priorDb = db;
  tokenizer = null;
  db = null;
  dbPath = null;
  priorTokenizer?.close();
  if (priorDb) closeSearchDatabase(priorDb);
}

async function requireTruncatedWal(status: WalCheckpointStatus, path: string): Promise<void> {
  if (status.busy !== 0 || status.logFrames !== 0 || status.checkpointedFrames !== 0) {
    throw new Error('SEARCH_WAL_CHECKPOINT_BUSY');
  }
  const size = await fs.stat(`${path}-wal`)
    .then((entry) => entry.size)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
  if (size !== 0) throw new Error('SEARCH_WAL_CHECKPOINT_INCOMPLETE');
}

function completionForPlan(result: SyncPlanResult): PhysicalStepResult {
  if (result.disposition === 'current') {
    return {
      kind: 'sync-plan',
      disposition: 'current',
      completion: 'terminal',
      state: result.state,
    };
  }
  if (result.disposition === 'checkpoint') {
    return {
      kind: 'sync-plan',
      disposition: 'checkpoint',
      completion: 'terminal',
      state: result.state,
    };
  }
  return {
    kind: 'sync-plan',
    disposition: result.disposition,
    completion: 'continue',
    state: result.state,
  };
}

function superseded(chatId: string): PhysicalStepResult {
  return { kind: 'mutation-superseded', completion: 'terminal', chatId };
}

function requireResultState(state: SearchChatState | undefined): SearchChatState {
  if (!state) throw new Error('SEARCH_STATE_INVARIANT');
  return state;
}

function executePhysicalStep(step: IndexerPhysicalStep): PhysicalStepResult {
  const database = requireDb();
  switch (step.kind) {
    case 'plan-replacement':
      return completionForPlan(planReplacement(database, step));
    case 'plan-append':
      return completionForPlan(planAppend(database, step));
    case 'stage-raw': {
      const batch = requireTokenizer().tokenizeDocuments(step.rows.map((row) => row.body));
      if (batch.acceptedDocumentCount === 0) throw new Error('SEARCH_TOKENIZER_LIMIT');
      const result = stageRawChunks(database, {
        expectedState: step.expectedState,
        rows: step.rows.slice(0, batch.acceptedDocumentCount),
        documents: batch.documents,
      });
      if (result.disposition === 'superseded') return superseded(step.expectedState.chatId);
      return {
        kind: 'raw-staged',
        completion: 'continue',
        state: requireResultState(result.state),
        acceptedRows: result.acceptedRows ?? 0,
      };
    }
    case 'build-terms': {
      const source = readActiveChunkBody(database, step.expectedState);
      if (source.disposition === 'superseded') return superseded(step.expectedState.chatId);
      const document = requireTokenizer().tokenizeDocument(source.body);
      const result = buildTermStep(database, { expectedState: step.expectedState, document });
      if (result.disposition === 'superseded') return superseded(step.expectedState.chatId);
      return {
        kind: 'term-progress',
        completion: 'continue',
        state: requireResultState(result.state),
        insertedTerms: result.insertedTerms ?? 0,
        insertedOccurrences: result.insertedOccurrences ?? 0,
        completedChunk: result.completedChunk ?? false,
      };
    }
    case 'advance-frontier': {
      const result = advanceFrontier(database, step);
      if (result.disposition === 'superseded') return superseded(step.expectedState.chatId);
      return {
        kind: 'frontier-progress',
        completion: 'continue',
        state: requireResultState(result.state),
      };
    }
    case 'activate': {
      const result = activateChat(database, step);
      if (result.disposition === 'superseded') return superseded(step.expectedState.chatId);
      return {
        kind: 'indexed',
        completion: 'terminal',
        state: requireResultState(result.state),
      };
    }
    case 'start-removal': {
      const result = startRemoval(database, step.chatId);
      if (result.disposition === 'chat-deleted') {
        return { kind: 'chat-deleted', completion: 'terminal', chatId: result.chatId };
      }
      return completionForPlan(result);
    }
    case 'cleanup': {
      const result = cleanupStep(database, step);
      if (result.disposition === 'superseded') return superseded(result.chatId);
      if (result.disposition === 'chat-deleted') {
        return { kind: 'chat-deleted', completion: 'terminal', chatId: result.chatId };
      }
      if (result.disposition === 'replacement-checkpoint') {
        return {
          kind: 'replacement-checkpoint',
          completion: 'terminal',
          state: result.state,
        };
      }
      return {
        kind: 'cleanup-progress',
        completion: 'continue',
        state: result.state,
        deletedTerms: result.deletedTerms,
        deletedRows: result.deletedRows,
        deletedBodyBytes: result.deletedBodyBytes,
      };
    }
    case 'complete-replacement-checkpoint': {
      const result = completeReplacementCheckpoint(database, step);
      if (result.disposition === 'superseded') return superseded(step.expectedState.chatId);
      return completionForPlan(result);
    }
    case 'mark-failed': {
      const result = markChatFailed(database, step);
      return {
        kind: 'failure-recorded',
        completion: 'terminal',
        applied: result.applied,
      };
    }
    case 'prune-mark': {
      const result = markPrunedChats(database, step);
      return {
        kind: 'prune-progress',
        completion: result.done ? 'terminal' : 'continue',
        cleanups: result.cleanups,
        nextAfterChatId: result.nextAfterChatId,
        done: result.done,
      };
    }
  }
}

async function handleOpen(request: Extract<IndexerRequest, { type: 'open' }>): Promise<void> {
  closing = false;
  walFenced = false;
  activeGrantId = null;
  lifecycleEpoch = request.lifecycleEpoch;
  walEpoch = request.walEpoch;
  walObservationSequence = 0;
  closeResources();
  const nextTokenizer = SearchTokenizer.create();
  try {
    const opened = await openSearchDatabase(request.dbPath, {
      tokenizerFingerprint: nextTokenizer.fingerprint,
    });
    tokenizer = nextTokenizer;
    db = opened.db;
    dbPath = opened.dbPath;
    const checkpoint = truncateWal(opened.db);
    await requireTruncatedWal(checkpoint, opened.dbPath);
    post({ type: 'opened', ...identity(request), wal: observeForEvent() });
  } catch (error) {
    nextTokenizer.close();
    if (db) closeResources();
    throw error;
  }
}

function handlePhysicalGrant(
  request: Extract<IndexerRequest, { type: 'physical-step-grant' }>,
): void {
  if (activeGrantId !== null) throw new Error('INDEXER_GRANT_CONFLICT');
  activeGrantId = request.grantId;
  try {
    try {
      post({ type: 'step-started', ...identity(request), grantId: request.grantId });
      if (walFenced || request.walEpoch !== walEpoch) {
        throw new Error('SEARCH_WAL_MAINTENANCE_REQUIRED');
      }
      const result = executePhysicalStep(request.step);
      let wal: WalObservation | undefined;
      try {
        wal = observeForEvent();
      } catch {
        walFenced = true;
      }
      post({
        type: 'physical-step-complete',
        ...identity(request),
        grantId: request.grantId,
        result,
        ...(wal ? { wal } : {}),
      });
    } catch (error) {
      const code = knownOutcomeErrorCode(error);
      if (code === null) throw error;
      let wal: WalObservation | undefined;
      try {
        wal = observeForEvent();
      } catch {
        walFenced = true;
      }
      post({
        type: 'error',
        ...identity(request),
        grantId: request.grantId,
        code,
        retryable: retryableError(code),
        ...(wal ? { wal } : {}),
      });
    }
  } finally {
    activeGrantId = null;
  }
}

async function handleCheckpoint(
  request: Extract<IndexerRequest, { type: 'checkpoint' }>,
): Promise<void> {
  if (activeGrantId !== null || request.walEpoch !== walEpoch) {
    throw new Error('SEARCH_WAL_MAINTENANCE_REQUIRED');
  }
  const databasePath = dbPath;
  if (!databasePath) throw new Error('INDEXER_UNAVAILABLE');
  const status = truncateWal(requireDb());
  await requireTruncatedWal(status, databasePath);
  walFenced = false;
  const wal = observeForEvent();
  post({
    type: 'checkpoint-complete',
    ...identity(request),
    busy: status.busy,
    logFrames: status.logFrames,
    checkpointedFrames: status.checkpointedFrames,
    wal,
  });
}

function handleQuiesce(request: Extract<IndexerRequest, { type: 'indexer-quiesce' }>): void {
  if (activeGrantId !== null) throw new Error('INDEXER_GRANT_CONFLICT');
  closing = true;
  closeResources();
  post({ type: 'indexer-quiesced', ...identity(request) });
  process.exit(0);
}

export async function handleIndexerRequest(request: IndexerRequest): Promise<void> {
  if (request.type !== 'open' && request.lifecycleEpoch !== lifecycleEpoch) return;
  try {
    switch (request.type) {
      case 'open':
        await handleOpen(request);
        return;
      case 'physical-step-grant':
        handlePhysicalGrant(request);
        return;
      case 'checkpoint':
        await handleCheckpoint(request);
        return;
      case 'indexer-quiesce':
        handleQuiesce(request);
        return;
    }
  } catch (error) {
    const code = explicitErrorCode(error);
    post({
      type: 'error',
      ...identity(request),
      grantId: request.type === 'physical-step-grant' ? request.grantId : null,
      code,
      retryable: retryableError(code),
    });
  }
}
