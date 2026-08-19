import { Database } from 'bun:sqlite';
import type { HistoricalSearchMessageRow } from './rows.js';
import {
  compareSearchTerms,
  decodeCanonicalPositions,
  type TokenizedDocument,
} from './tokenizer.js';
import {
  PROGRESS_MATCH_SQL,
  ROLE_CODES,
  SEARCH_CHUNK_HAS_TERMS_SQL,
  SEARCH_GREATEST_PERSISTED_POSTING_SQL,
  SEARCH_PERSISTED_SUCCESSOR_SQL,
  SEARCH_PRUNE_CORPUS_SUBTRACT_SQL,
  SEARCH_PRUNE_MAX_STATES,
  SEARCH_RAW_DELETE_CANDIDATES_SQL,
  SEARCH_RAW_STAGE_MAX_BYTES,
  SEARCH_RAW_STAGE_MAX_ROWS,
  SEARCH_TERM_STEP_MAX_BYTES,
  SEARCH_TERM_STEP_MAX_ROWS,
  STATE_MATCH_SQL,
  type ActivationResult,
  type ChunkWithProgress,
  type CleanupResult,
  type FailureRecordResult,
  type FrontierResult,
  type PruneMarkResult,
  type PrunedChatCleanup,
  type RawStageResult,
  type SearchChatState,
  type SearchChunkProgress,
  type SearchSqlBinding,
  type SyncPlanDisposition,
  type SyncPlanResult,
  type TermBuildResult,
  firstSlotChunk,
  getChatState,
  isSafeNonNegative,
  nextIncompleteChunkId,
  nextTimestamp,
  nextViewChunk,
  progressArguments,
  readChunkWithProgress,
  readProgress,
  requireIdentifier,
  requireOneChange,
  runTransaction,
  sameBytes,
  sameProgress,
  sameState,
  searchError,
  stateArguments,
  subtractActiveSlot,
  validBoundedText,
} from './schema-database.js';

function planDisposition(state: SearchChatState): SyncPlanDisposition {
  if (state.status === 'indexed') return 'current';
  if (state.phase === 'replacement-cleanup' || state.phase === 'removal-cleanup') return 'cleanup';
  if (state.phase === 'replacement-checkpoint') return 'checkpoint';
  return 'build';
}

export function planReplacement(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly targetThrough: number;
}): SyncPlanResult {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (!isSafeNonNegative(input.targetThrough)) throw searchError('SEARCH_FRONTIER_INVALID');
  const current = getChatState(db, input.chatId);
  if (current?.status === 'indexed'
      && current.phase === 'idle'
      && current.transcriptViewId === input.transcriptViewId
      && current.processedThrough >= input.targetThrough
      && current.targetThrough >= input.targetThrough) {
    return { disposition: 'current', state: current };
  }
  return runTransaction(db, () => {
    const prior = getChatState(db, input.chatId);
    if (!prior) {
      const updatedAt = nextTimestamp();
      db.query(`
        INSERT INTO search_chat_state(
          chat_id, transcript_view_id, status, phase, target_through,
          processed_through, active_chunk_id, slot_document_count,
          slot_token_count, last_error_code, updated_at
        ) VALUES (?, ?, 'pending', 'replacement-build', ?, 0, NULL, 0, 0, NULL, ?)
      `).run(input.chatId, input.transcriptViewId, input.targetThrough, updatedAt);
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'build', state };
    }
    if (prior.status === 'indexed'
        && prior.phase === 'idle'
        && prior.transcriptViewId === input.transcriptViewId
        && prior.processedThrough >= input.targetThrough
        && prior.targetThrough >= input.targetThrough) {
      return { disposition: 'current', state: prior };
    }
    if (prior.transcriptViewId === input.transcriptViewId
        && prior.targetThrough === input.targetThrough
        && prior.status !== 'indexed') {
      if (prior.status === 'failed') {
        const updatedAt = nextTimestamp(prior.updatedAt);
        requireOneChange(db.query(`
          UPDATE search_chat_state SET status = 'pending', last_error_code = NULL, updated_at = ?
          WHERE ${STATE_MATCH_SQL}
        `).run(updatedAt, ...stateArguments(prior)));
      }
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: planDisposition(state), state };
    }
    if (prior.status === 'indexed'
        && prior.phase === 'idle'
        && prior.transcriptViewId === input.transcriptViewId
        && prior.processedThrough < input.targetThrough) {
      subtractActiveSlot(db, prior);
      const updatedAt = nextTimestamp(prior.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET status = 'pending', phase = 'append-build', target_through = ?,
          last_error_code = NULL, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(input.targetThrough, updatedAt, ...stateArguments(prior)));
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'build', state };
    }
    subtractActiveSlot(db, prior);
    const activeChunkId = firstSlotChunk(db, prior.chatId)?.id ?? null;
    const updatedAt = nextTimestamp(prior.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET transcript_view_id = ?, status = 'pending', phase = 'replacement-cleanup',
        target_through = ?, processed_through = 0, active_chunk_id = ?,
        last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(
      input.transcriptViewId,
      input.targetThrough,
      activeChunkId,
      updatedAt,
      ...stateArguments(prior),
    ));
    const state = getChatState(db, input.chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'cleanup', state };
  });
}

export function planAppend(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly expectedAfterOrdinal: number;
  readonly targetThrough: number;
}): SyncPlanResult {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (!isSafeNonNegative(input.expectedAfterOrdinal)
      || !isSafeNonNegative(input.targetThrough)
      || input.targetThrough < input.expectedAfterOrdinal) {
    throw searchError('SEARCH_FRONTIER_INVALID');
  }
  return runTransaction(db, () => {
    const prior = getChatState(db, input.chatId);
    if (!prior || prior.transcriptViewId !== input.transcriptViewId) {
      throw searchError('SEARCH_VIEW_MISMATCH');
    }
    if (prior.status === 'indexed' && prior.phase === 'idle'
        && prior.processedThrough >= input.targetThrough) {
      return { disposition: 'current', state: prior };
    }
    if (prior.status !== 'indexed'
        && prior.targetThrough === input.targetThrough
        && prior.processedThrough >= input.expectedAfterOrdinal
        && (prior.phase === 'append-build' || prior.phase === 'replacement-build')) {
      if (prior.status === 'failed') {
        const updatedAt = nextTimestamp(prior.updatedAt);
        requireOneChange(db.query(`
          UPDATE search_chat_state SET status = 'pending', last_error_code = NULL, updated_at = ?
          WHERE ${STATE_MATCH_SQL}
        `).run(updatedAt, ...stateArguments(prior)));
      }
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'build', state };
    }
    if (prior.status !== 'indexed' || prior.phase !== 'idle'
        || prior.processedThrough !== input.expectedAfterOrdinal) {
      throw searchError('SEARCH_INDEX_GAP');
    }
    subtractActiveSlot(db, prior);
    const updatedAt = nextTimestamp(prior.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'pending', phase = 'append-build', target_through = ?,
        last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(input.targetThrough, updatedAt, ...stateArguments(prior)));
    const state = getChatState(db, input.chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'build', state };
  });
}

function validateRawStageRows(
  expectedState: SearchChatState,
  rows: readonly HistoricalSearchMessageRow[],
  documents: readonly TokenizedDocument[],
): void {
  if (rows.length === 0 || rows.length > SEARCH_RAW_STAGE_MAX_ROWS
      || rows.length !== documents.length) {
    throw searchError('SEARCH_RAW_STAGE_INVALID');
  }
  let rawBytes = 0;
  let previousOrdinal = expectedState.processedThrough;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const document = documents[index]!;
    const bodyBytes = Buffer.byteLength(row.body, 'utf8');
    rawBytes += bodyBytes;
    if (!Number.isSafeInteger(row.ordinal)
        || row.ordinal <= previousOrdinal
        || row.ordinal > expectedState.targetThrough
        || !Object.hasOwn(ROLE_CODES, row.role)
        || !validBoundedText(row.body, SEARCH_RAW_STAGE_MAX_BYTES)
        || (row.timestamp !== null && !validBoundedText(row.timestamp, 256))
        || document.document !== index + 1
        || document.tokenCount < 1
        || document.termCount !== document.postings.length
        || document.termCount > document.tokenCount - 1
        || document.termBytes < document.termCount
        || document.positionBytes < document.tokenCount - 1) {
      throw searchError('SEARCH_RAW_STAGE_INVALID');
    }
    previousOrdinal = row.ordinal;
  }
  if (rawBytes > SEARCH_RAW_STAGE_MAX_BYTES) throw searchError('SEARCH_RAW_STAGE_INVALID');
}

export function stageRawChunks(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly rows: readonly HistoricalSearchMessageRow[];
  readonly documents: readonly TokenizedDocument[];
}): RawStageResult {
  validateRawStageRows(input.expectedState, input.rows, input.documents);
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.activeChunkId !== null) {
    throw searchError('SEARCH_RAW_STAGE_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    if (nextViewChunk(
      db,
      state.chatId,
      state.transcriptViewId,
      state.processedThrough,
    ) !== null) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const insertChunk = db.query(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
        token_count, term_count, term_bytes, position_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const insertProgress = db.query(`
      INSERT INTO search_chunk_progress(
        chunk_id, complete, persisted_term_count, persisted_occurrence_count,
        persisted_term_bytes, persisted_position_bytes, term_cursor
      ) VALUES (?, 0, 0, 0, 0, 0, NULL)
    `);
    let firstId: number | null = null;
    for (let index = 0; index < input.rows.length; index += 1) {
      const row = input.rows[index]!;
      const document = input.documents[index]!;
      const inserted = insertChunk.get(
        state.chatId,
        state.transcriptViewId,
        row.ordinal,
        ROLE_CODES[row.role],
        row.timestamp,
        row.body,
        Buffer.byteLength(row.body, 'utf8'),
        document.tokenCount,
        document.termCount,
        document.termBytes,
        document.positionBytes,
      ) as { id: number } | null;
      const id = Number(inserted?.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw searchError('SEARCH_STATE_INVARIANT');
      firstId ??= id;
      insertProgress.run(id);
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state SET active_chunk_id = ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(firstId, updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'raw-staged', state: updated, acceptedRows: input.rows.length };
  });
}

function validateTokenizedDocument(chunk: ChunkWithProgress, document: TokenizedDocument): void {
  if (document.document !== 1
      || !Number.isSafeInteger(document.tokenCount)
      || document.tokenCount < 1
      || !Number.isSafeInteger(document.termCount)
      || document.termCount < 0
      || document.termCount > document.tokenCount - 1
      || !Number.isSafeInteger(document.termBytes)
      || document.termBytes < document.termCount
      || !Number.isSafeInteger(document.positionBytes)
      || document.positionBytes < document.tokenCount - 1
      || document.postings.length !== document.termCount) {
    throw searchError('SEARCH_POSTING_INVALID');
  }
  let occurrences = 0;
  let termBytes = 0;
  let positionBytes = 0;
  let previous: Uint8Array | null = null;
  for (const posting of document.postings) {
    if (posting.term.byteLength === 0 || posting.term.byteLength > 32_768
        || (previous !== null && compareSearchTerms(previous, posting.term) >= 0)) {
      throw searchError('SEARCH_POSTING_INVALID');
    }
    decodeCanonicalPositions({
      encoded: posting.positions,
      frequency: posting.frequency,
      maxPositionExclusive: document.tokenCount - 1,
    });
    occurrences += posting.frequency;
    termBytes += posting.term.byteLength;
    positionBytes += posting.positions.byteLength;
    previous = posting.term;
  }
  if (occurrences !== document.tokenCount - 1
      || termBytes !== document.termBytes
      || positionBytes !== document.positionBytes) {
    throw searchError('SEARCH_POSTING_INVALID');
  }
  if (document.tokenCount !== chunk.tokenCount
      || document.termCount !== chunk.termCount
      || document.termBytes !== chunk.termBytes
      || document.positionBytes !== chunk.positionBytes) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
}

function postingPrefix(
  document: TokenizedDocument,
  progress: SearchChunkProgress,
): {
  readonly selected: readonly TokenizedDocument['postings'][number][];
  readonly final: boolean;
  readonly prefixOccurrences: number;
  readonly prefixTermBytes: number;
  readonly prefixPositionBytes: number;
} {
  let start = 0;
  let prefixOccurrences = 0;
  let prefixTermBytes = 0;
  let prefixPositionBytes = 0;
  if (progress.termCursor !== null) {
    const cursorIndex = document.postings.findIndex(
      (posting) => compareSearchTerms(posting.term, progress.termCursor!) === 0,
    );
    if (cursorIndex < 0) throw searchError('SEARCH_INDEX_CORRUPT');
    start = cursorIndex + 1;
    for (const posting of document.postings.slice(0, start)) {
      prefixOccurrences += posting.frequency;
      prefixTermBytes += posting.term.byteLength;
      prefixPositionBytes += posting.positions.byteLength;
    }
  }
  if (start !== progress.persistedTermCount
      || prefixOccurrences !== progress.persistedOccurrenceCount
      || prefixTermBytes !== progress.persistedTermBytes
      || prefixPositionBytes !== progress.persistedPositionBytes) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
  const selected: TokenizedDocument['postings'][number][] = [];
  let selectedBytes = 0;
  for (const posting of document.postings.slice(start)) {
    const bytes = posting.term.byteLength + posting.positions.byteLength;
    if (selected.length >= SEARCH_TERM_STEP_MAX_ROWS
        || selectedBytes + bytes > SEARCH_TERM_STEP_MAX_BYTES) break;
    selected.push(posting);
    selectedBytes += bytes;
  }
  if (start < document.postings.length && selected.length === 0) {
    throw searchError('SEARCH_POSTING_INVALID');
  }
  return {
    selected,
    final: start + selected.length === document.postings.length,
    prefixOccurrences,
    prefixTermBytes,
    prefixPositionBytes,
  };
}

function requireDurablePostingCursor(
  db: Database,
  chunk: ChunkWithProgress,
  document: TokenizedDocument,
): void {
  const greatest = db.query<{
    term: Uint8Array;
    frequency: number;
    positions: Uint8Array;
  }, [number]>(SEARCH_GREATEST_PERSISTED_POSTING_SQL).get(chunk.id);
  if (chunk.persistedTermCount === 0) {
    if (greatest || chunk.termCursor !== null) throw searchError('SEARCH_INDEX_CORRUPT');
    return;
  }
  const expected = document.postings[chunk.persistedTermCount - 1];
  if (!greatest || !expected || chunk.termCursor === null
      || compareSearchTerms(greatest.term, chunk.termCursor) !== 0
      || compareSearchTerms(greatest.term, expected.term) !== 0
      || greatest.frequency !== expected.frequency
      || compareSearchTerms(greatest.positions, expected.positions) !== 0) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
}

function requireNoPersistedSuccessor(
  db: Database,
  chunkId: number,
  greatestExpectedTerm: Uint8Array | undefined,
): void {
  if (!greatestExpectedTerm) {
    const any = db.query<{ present: number }, [number]>(`
      SELECT EXISTS(SELECT 1 FROM search_chunk_terms WHERE chunk_id = ?) AS present
    `).get(chunkId)?.present;
    if (Number(any) !== 0) throw searchError('SEARCH_INDEX_CORRUPT');
    return;
  }
  const successor = db.query<{ term: Uint8Array }, [number, Uint8Array]>(
    SEARCH_PERSISTED_SUCCESSOR_SQL,
  ).get(chunkId, greatestExpectedTerm);
  if (successor) throw searchError('SEARCH_INDEX_CORRUPT');
}

export function buildTermStep(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly document: TokenizedDocument;
}): TermBuildResult {
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.activeChunkId === null) {
    throw searchError('SEARCH_TERM_BUILD_INVALID');
  }
  const initialState = getChatState(db, input.expectedState.chatId);
  if (!sameState(initialState, input.expectedState)) return { disposition: 'superseded' };
  const initialChunk = readChunkWithProgress(db, input.expectedState.activeChunkId);
  if (!initialChunk || initialChunk.chatId !== input.expectedState.chatId
      || initialChunk.transcriptViewId !== input.expectedState.transcriptViewId
      || initialChunk.complete !== 0) {
    throw searchError('SEARCH_STATE_INVARIANT');
  }
  validateTokenizedDocument(initialChunk, input.document);
  const selection = postingPrefix(input.document, initialChunk);
  requireDurablePostingCursor(db, initialChunk, input.document);
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    const chunk = readChunkWithProgress(db, input.expectedState.activeChunkId!);
    if (!chunk || !sameProgress(chunk, initialChunk)
        || chunk.body !== initialChunk.body
        || chunk.tokenCount !== initialChunk.tokenCount
        || chunk.termCount !== initialChunk.termCount
        || chunk.termBytes !== initialChunk.termBytes
        || chunk.positionBytes !== initialChunk.positionBytes) {
      return { disposition: 'superseded' };
    }
    requireDurablePostingCursor(db, chunk, input.document);
    let insertedOccurrences = 0;
    let insertedTermBytes = 0;
    let insertedPositionBytes = 0;
    const insert = db.query(`
      INSERT INTO search_chunk_terms(chunk_id, chat_id, term, frequency, positions)
      SELECT chunks.id, chunks.chat_id, ?, ?, ?
      FROM search_chunks AS chunks
      WHERE chunks.id = ? AND chunks.chat_id = ? AND chunks.transcript_view_id = ?
    `);
    for (const posting of selection.selected) {
      const result = insert.run(
        posting.term,
        posting.frequency,
        posting.positions,
        chunk.id,
        state.chatId,
        state.transcriptViewId,
      );
      requireOneChange(result);
      insertedOccurrences += posting.frequency;
      insertedTermBytes += posting.term.byteLength;
      insertedPositionBytes += posting.positions.byteLength;
    }
    const persistedTermCount = chunk.persistedTermCount + selection.selected.length;
    const persistedOccurrenceCount = chunk.persistedOccurrenceCount + insertedOccurrences;
    const persistedTermBytes = chunk.persistedTermBytes + insertedTermBytes;
    const persistedPositionBytes = chunk.persistedPositionBytes + insertedPositionBytes;
    const termCursor = selection.selected.at(-1)?.term ?? chunk.termCursor;
    if (selection.final
        && (persistedTermCount !== chunk.termCount
          || persistedOccurrenceCount !== chunk.tokenCount - 1
          || persistedTermBytes !== chunk.termBytes
          || persistedPositionBytes !== chunk.positionBytes)) {
      throw searchError('SEARCH_INDEX_CORRUPT');
    }
    if (selection.final) {
      requireNoPersistedSuccessor(db, chunk.id, input.document.postings.at(-1)?.term);
    }
    requireOneChange(db.query(`
      UPDATE search_chunk_progress
      SET complete = ?, persisted_term_count = ?, persisted_occurrence_count = ?,
        persisted_term_bytes = ?, persisted_position_bytes = ?, term_cursor = ?
      WHERE ${PROGRESS_MATCH_SQL}
    `).run(
      selection.final ? 1 : 0,
      persistedTermCount,
      persistedOccurrenceCount,
      persistedTermBytes,
      persistedPositionBytes,
      termCursor,
      ...progressArguments(chunk),
    ));
    let updatedState = state;
    if (selection.final) {
      const nextActiveChunkId = nextIncompleteChunkId(
        db,
        state.chatId,
        state.transcriptViewId,
        chunk.ordinal,
      );
      const updatedAt = nextTimestamp(state.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET processed_through = ?, active_chunk_id = ?,
          slot_document_count = slot_document_count + 1,
          slot_token_count = slot_token_count + ?, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(
        chunk.ordinal,
        nextActiveChunkId,
        chunk.tokenCount,
        updatedAt,
        ...stateArguments(state),
      ));
      const read = getChatState(db, state.chatId);
      if (!read) throw searchError('SEARCH_STATE_INVARIANT');
      updatedState = read;
    }
    return {
      disposition: 'term-progress',
      state: updatedState,
      insertedTerms: selection.selected.length,
      insertedOccurrences,
      completedChunk: selection.final,
    };
  });
}

export function advanceFrontier(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly throughOrdinal: number;
}): FrontierResult {
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.activeChunkId !== null
      || !Number.isSafeInteger(input.throughOrdinal)
      || input.throughOrdinal <= input.expectedState.processedThrough
      || input.throughOrdinal > input.expectedState.targetThrough) {
    throw searchError('SEARCH_FRONTIER_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    if (nextViewChunk(
      db,
      state.chatId,
      state.transcriptViewId,
      state.processedThrough,
    ) !== null) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state SET processed_through = ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(input.throughOrdinal, updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'frontier-progress', state: updated };
  });
}

export function activateChat(db: Database, input: {
  readonly expectedState: SearchChatState;
}): ActivationResult {
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.processedThrough !== input.expectedState.targetThrough
      || input.expectedState.activeChunkId !== null) {
    throw searchError('SEARCH_ACTIVATION_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    requireOneChange(db.query(`
      UPDATE search_corpus_stats
      SET document_count = document_count + ?, total_token_count = total_token_count + ?
      WHERE singleton = 1
    `).run(state.slotDocumentCount, state.slotTokenCount));
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'indexed', phase = 'idle', last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'indexed', state: updated };
  });
}

export function startRemoval(db: Database, chatId: string): SyncPlanResult | {
  readonly disposition: 'chat-deleted'; readonly chatId: string;
} {
  requireIdentifier(chatId);
  const current = getChatState(db, chatId);
  if (!current) return { disposition: 'chat-deleted', chatId };
  if (current.status === 'pending' && current.phase === 'removal-cleanup') {
    return { disposition: 'cleanup', state: current };
  }
  return runTransaction(db, () => {
    const prior = getChatState(db, chatId);
    if (!prior) return { disposition: 'chat-deleted' as const, chatId };
    if (prior.status === 'pending' && prior.phase === 'removal-cleanup') {
      return { disposition: 'cleanup' as const, state: prior };
    }
    subtractActiveSlot(db, prior);
    const activeChunkId = firstSlotChunk(db, chatId)?.id ?? null;
    const updatedAt = nextTimestamp(prior.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'pending', phase = 'removal-cleanup', active_chunk_id = ?,
        last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(activeChunkId, updatedAt, ...stateArguments(prior)));
    const state = getChatState(db, chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'cleanup' as const, state };
  });
}

function deleteTermBatch(
  db: Database,
  state: SearchChatState,
  chunk: ChunkWithProgress,
): CleanupResult {
  const candidates = db.query<{
    term: Uint8Array;
    frequency: number;
    positions: Uint8Array;
  }, [number, number]>(`
    SELECT term, frequency, positions FROM search_chunk_terms
    WHERE chunk_id = ? ORDER BY term DESC LIMIT ?
  `).all(chunk.id, SEARCH_TERM_STEP_MAX_ROWS);
  const selected: typeof candidates = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const rowBytes = candidate.term.byteLength + candidate.positions.byteLength;
    if (selected.length > 0 && bytes + rowBytes > SEARCH_TERM_STEP_MAX_BYTES) break;
    if (rowBytes > SEARCH_TERM_STEP_MAX_BYTES) throw searchError('SEARCH_INDEX_CORRUPT');
    selected.push(candidate);
    bytes += rowBytes;
  }
  if (selected.length === 0) throw searchError('SEARCH_STATE_INVARIANT');
  if (chunk.termCursor === null
      || compareSearchTerms(selected[0]!.term, chunk.termCursor) !== 0
      || selected.length > chunk.persistedTermCount) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
  let occurrences = 0;
  let termBytes = 0;
  let positionBytes = 0;
  const remove = db.query('DELETE FROM search_chunk_terms WHERE chunk_id = ? AND term = ?');
  for (const term of selected) {
    try {
      decodeCanonicalPositions({
        encoded: term.positions,
        frequency: term.frequency,
        maxPositionExclusive: chunk.tokenCount - 1,
      });
    } catch {
      throw searchError('SEARCH_INDEX_CORRUPT');
    }
    requireOneChange(remove.run(chunk.id, term.term));
    occurrences += term.frequency;
    termBytes += term.term.byteLength;
    positionBytes += term.positions.byteLength;
  }
  const remaining = db.query<{ term: Uint8Array }, [number]>(`
    SELECT term FROM search_chunk_terms WHERE chunk_id = ? ORDER BY term DESC LIMIT 1
  `).get(chunk.id)?.term ?? null;
  const remainingTermCount = chunk.persistedTermCount - selected.length;
  if (occurrences > chunk.persistedOccurrenceCount
      || termBytes > chunk.persistedTermBytes
      || positionBytes > chunk.persistedPositionBytes
      || (remainingTermCount === 0) !== (remaining === null)) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
  const wasComplete = chunk.complete === 1;
  requireOneChange(db.query(`
    UPDATE search_chunk_progress
    SET complete = 0,
      persisted_term_count = persisted_term_count - ?,
      persisted_occurrence_count = persisted_occurrence_count - ?,
      persisted_term_bytes = persisted_term_bytes - ?,
      persisted_position_bytes = persisted_position_bytes - ?,
      term_cursor = ?
    WHERE ${PROGRESS_MATCH_SQL}
  `).run(
    selected.length,
    occurrences,
    termBytes,
    positionBytes,
    remaining,
    ...progressArguments(chunk),
  ));
  let updatedState = state;
  if (wasComplete) {
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET slot_document_count = slot_document_count - 1,
        slot_token_count = slot_token_count - ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
        AND slot_document_count > 0 AND slot_token_count >= ?
    `).run(chunk.tokenCount, updatedAt, ...stateArguments(state), chunk.tokenCount));
    const read = getChatState(db, state.chatId);
    if (!read) throw searchError('SEARCH_STATE_INVARIANT');
    updatedState = read;
  }
  return {
    disposition: 'cleanup-progress',
    state: updatedState,
    deletedTerms: selected.length,
    deletedRows: 0,
    deletedBodyBytes: 0,
  };
}

function deleteRawBatch(
  db: Database,
  state: SearchChatState,
  first: ChunkWithProgress,
): CleanupResult {
  const candidates = db.query<ChunkWithProgress, [string, string, number]>(
    SEARCH_RAW_DELETE_CANDIDATES_SQL,
  ).all(state.chatId, first.transcriptViewId, first.ordinal).map((row) => ({
    ...row,
    termCursor: row.termCursor === null ? null : Uint8Array.from(row.termCursor),
  }));
  const selected: ChunkWithProgress[] = [];
  let bodyBytes = 0;
  for (const candidate of candidates) {
    if (candidate.persistedTermCount !== 0 || candidate.termCursor !== null) break;
    if (selected.length > 0 && bodyBytes + candidate.bodyBytes > SEARCH_RAW_STAGE_MAX_BYTES) break;
    if (candidate.bodyBytes > SEARCH_RAW_STAGE_MAX_BYTES) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const hasTerms = Number(db.query<{ present: number }, [number]>(
      SEARCH_CHUNK_HAS_TERMS_SQL,
    ).get(candidate.id)?.present ?? -1);
    if (hasTerms !== 0) throw searchError('SEARCH_INDEX_CORRUPT');
    selected.push(candidate);
    bodyBytes += candidate.bodyBytes;
  }
  if (selected.length === 0 || selected[0]!.id !== first.id) {
    throw searchError('SEARCH_STATE_INVARIANT');
  }
  let slotDocuments = state.slotDocumentCount;
  let slotTokens = state.slotTokenCount;
  for (const candidate of selected) {
    if (candidate.complete === 1) {
      slotDocuments -= 1;
      slotTokens -= candidate.tokenCount;
    }
    requireOneChange(db.query(`
      DELETE FROM search_chunk_progress WHERE ${PROGRESS_MATCH_SQL}
    `).run(...progressArguments(candidate)));
    requireOneChange(db.query('DELETE FROM search_chunks WHERE id = ? AND chat_id = ?')
      .run(candidate.id, state.chatId));
  }
  if (slotDocuments < 0 || slotTokens < slotDocuments) {
    throw searchError('SEARCH_STATE_INVARIANT');
  }
  const nextActiveChunkId = firstSlotChunk(db, state.chatId)?.id ?? null;
  const updatedAt = nextTimestamp(state.updatedAt);
  requireOneChange(db.query(`
    UPDATE search_chat_state
    SET active_chunk_id = ?, slot_document_count = ?, slot_token_count = ?, updated_at = ?
    WHERE ${STATE_MATCH_SQL}
  `).run(
    nextActiveChunkId,
    slotDocuments,
    slotTokens,
    updatedAt,
    ...stateArguments(state),
  ));
  const updated = getChatState(db, state.chatId);
  if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
  return {
    disposition: 'cleanup-progress',
    state: updated,
    deletedTerms: 0,
    deletedRows: selected.length,
    deletedBodyBytes: bodyBytes,
  };
}

export function cleanupStep(db: Database, input: {
  readonly expectedState: SearchChatState;
}): CleanupResult {
  if (input.expectedState.status !== 'pending'
      || !['replacement-cleanup', 'removal-cleanup'].includes(input.expectedState.phase)) {
    throw searchError('SEARCH_CLEANUP_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) {
      return { disposition: 'superseded', chatId: input.expectedState.chatId };
    }
    if (state.activeChunkId === null) {
      if (firstSlotChunk(db, state.chatId) !== null
          || state.slotDocumentCount !== 0 || state.slotTokenCount !== 0) {
        throw searchError('SEARCH_STATE_INVARIANT');
      }
      if (state.phase === 'removal-cleanup') {
        requireOneChange(db.query(`DELETE FROM search_chat_state WHERE ${STATE_MATCH_SQL}`)
          .run(...stateArguments(state)));
        return { disposition: 'chat-deleted', chatId: state.chatId };
      }
      const updatedAt = nextTimestamp(state.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET phase = 'replacement-checkpoint', active_chunk_id = NULL, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(updatedAt, ...stateArguments(state)));
      const updated = getChatState(db, state.chatId);
      if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'replacement-checkpoint', state: updated };
    }
    const chunk = readChunkWithProgress(db, state.activeChunkId);
    if (!chunk || chunk.chatId !== state.chatId) throw searchError('SEARCH_STATE_INVARIANT');
    if (chunk.persistedTermCount > 0) return deleteTermBatch(db, state, chunk);
    return deleteRawBatch(db, state, chunk);
  });
}

export function completeReplacementCheckpoint(db: Database, input: {
  readonly expectedState: SearchChatState;
}): SyncPlanResult | { readonly disposition: 'superseded'; readonly state: SearchChatState } {
  if (input.expectedState.status !== 'pending'
      || input.expectedState.phase !== 'replacement-checkpoint') {
    throw searchError('SEARCH_CHECKPOINT_STATE_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) {
      return { disposition: 'superseded' as const, state: input.expectedState };
    }
    if (firstSlotChunk(db, state.chatId) !== null
        || state.slotDocumentCount !== 0 || state.slotTokenCount !== 0) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET phase = 'replacement-build', processed_through = 0,
        active_chunk_id = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'build' as const, state: updated };
  });
}

export function markChatFailed(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly errorCode: string;
}): FailureRecordResult {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)
      || input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)) {
    throw searchError('INVALID_SEARCH_ERROR_CODE');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) {
      return { disposition: 'failure-recorded', applied: false };
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'failed', last_error_code = ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(input.errorCode, updatedAt, ...stateArguments(state)));
    return { disposition: 'failure-recorded', applied: true };
  });
}

export function markPrunedChats(db: Database, input: {
  readonly allowedChatIds: readonly string[];
  readonly afterChatId: string | null;
}): PruneMarkResult {
  if (!Array.isArray(input.allowedChatIds) || input.allowedChatIds.length > 10_000
      || input.allowedChatIds.some((chatId) => {
        try { requireIdentifier(chatId); return false; } catch { return true; }
      })
      || (input.afterChatId !== null && !validBoundedText(input.afterChatId, 256))) {
    throw searchError('SEARCH_PRUNE_INVALID');
  }
  const allowed = JSON.stringify([...new Set(input.allowedChatIds)]);
  return runTransaction(db, () => {
    const states = db.query<SearchChatState, [string, number]>(`
      SELECT chat_id AS chatId, transcript_view_id AS transcriptViewId,
        status, phase, target_through AS targetThrough,
        processed_through AS processedThrough, active_chunk_id AS activeChunkId,
        slot_document_count AS slotDocumentCount, slot_token_count AS slotTokenCount,
        last_error_code AS lastErrorCode, updated_at AS updatedAt
      FROM search_chat_state
      WHERE chat_id > ? ORDER BY chat_id LIMIT ?
    `).all(input.afterChatId ?? '', SEARCH_PRUNE_MAX_STATES);
    const cleanups: PrunedChatCleanup[] = [];
    let subtractedDocuments = 0;
    let subtractedTokens = 0;
    for (const prior of states) {
      const present = Number(db.query<{ present: number }, [string, string]>(`
        SELECT EXISTS(
          SELECT 1 FROM json_each(?) WHERE CAST(value AS TEXT) = ?
        ) AS present
      `).get(allowed, prior.chatId)?.present ?? 0) === 1;
      if (present) continue;
      if (prior.status === 'pending' && prior.phase === 'removal-cleanup') {
        cleanups.push({ expectedState: prior });
        continue;
      }
      if (prior.status === 'indexed' && prior.phase === 'idle') {
        subtractedDocuments += prior.slotDocumentCount;
        subtractedTokens += prior.slotTokenCount;
      }
      const activeChunkId = firstSlotChunk(db, prior.chatId)?.id ?? null;
      const updatedAt = nextTimestamp(prior.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET status = 'pending', phase = 'removal-cleanup', active_chunk_id = ?,
          last_error_code = NULL, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(activeChunkId, updatedAt, ...stateArguments(prior)));
      const updated = getChatState(db, prior.chatId);
      if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
      cleanups.push({ expectedState: updated });
    }
    if (subtractedDocuments > 0 || subtractedTokens > 0) {
      requireOneChange(db.query(SEARCH_PRUNE_CORPUS_SUBTRACT_SQL).run(
        subtractedDocuments,
        subtractedTokens,
        subtractedDocuments,
        subtractedTokens,
      ));
    }
    const done = states.length < SEARCH_PRUNE_MAX_STATES;
    return {
      disposition: 'prune-progress',
      cleanups,
      nextAfterChatId: done ? null : states.at(-1)!.chatId,
      done,
    };
  });
}
