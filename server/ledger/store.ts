import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import { chmodSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  parseChatRowContent,
  parseChatRowTitle,
} from '../../common/chat-row-contracts.js';
import { createLogger } from '../lib/log.js';
import {
  decodeLedgerRow,
  decodeStoredLedgerRow,
  cliRowFingerprint,
  encodeLedgerDraft,
  parseLedgerCliRowNoticeDetail,
  type StoredLedgerRow,
} from './codec.js';
import type {
  AppendChatRowRequest,
  AppendChatRowResult,
  AppendInputRequest,
  AppendSelectionChangeNoticeResult,
  InputComposition,
  LedgerCliRowNoticeRow,
  LedgerCheckpoint,
  LedgerPreambleSelectionChangedNoticeDetail,
  LedgerPreambleSelectionChangedNoticeRow,
  LedgerRow,
  LedgerRowDraft,
  LedgerSessionRow,
  TranscriptNativeActivityState,
  LedgerUserInputDetail,
  LedgerUserInputRow,
  TranscriptPage,
  TranscriptView,
  TranscriptViewId,
  TranscriptWatermark,
} from './contracts.js';
import { ensureLedgerChatDirectory, ensureLedgerRootDirectory } from './directories.js';
import {
  isLedgerCliRowNoticeRow,
  isLedgerPreambleSelectionChangedNoticeRow,
  isPresentationOnlyProviderRow,
  PREAMBLES_UPDATED_MESSAGE,
  transcriptViewId,
} from './contracts.js';
import {
  IncompleteLedgerCheckpointError,
  LedgerFencedError,
  LedgerSchemaError,
  StaleTranscriptViewError,
  SubmissionConflictError,
  TranscriptViewNotInitializedError,
} from './errors.js';
import { LedgerFailureFences } from './failure-fences.js';
import type { ConnectionEntry } from './connection-entry.js';
import {
  closeConnection,
  configureConnection,
  createSchema,
  loadAndCleanViews,
  openConnection,
  rehydrateConnection,
  toView,
  validateSchema,
  viewRecord,
} from './connection-setup.js';
import { lstatIfExists, statSizeIfExists } from './file-stat.js';
import { readProviderActivityWatermark } from './native-activity-query.js';
import {
  asError,
  nextOrdinal,
  runQuery,
  runTransaction,
} from './sqlite-operations.js';
import type { PendingPreambleBoundary } from '../../common/preambles.js';
import {
  hasPreambleBoundaryProof as queryPreambleBoundaryProof,
  preparePreambleInput,
} from './preamble-application.js';
import { matchingInputSubmission, readSubmission } from './input-submission.js';

const LEDGER_SCHEMA_VERSION = 1;
const DEFAULT_CONNECTION_CACHE_SIZE = 10;
const CHAT_DIRECTORY_PATTERN = /^[A-Za-z0-9_-]+$/;
const logger = createLogger('ledger:store');


export interface TranscriptLedgerStoreOptions {
  readonly connectionCacheSize?: number;
  readonly createViewId?: () => TranscriptViewId;
  readonly now?: () => string;
  readonly synchronous?: 'NORMAL' | 'FULL';
}

export interface InitializeViewInput {
  readonly viewId?: TranscriptViewId;
  readonly contentStartOrdinal: number;
  readonly rows?: readonly LedgerRowDraft[];
}

export interface StageViewInput extends InitializeViewInput {
  readonly viewId: TranscriptViewId;
}
export class TranscriptLedgerStore {
  readonly #rootDirectory: string;
  readonly #cacheSize: number;
  readonly #createViewId: () => TranscriptViewId;
  readonly #now: () => string;
  readonly #synchronous: 'NORMAL' | 'FULL';
  readonly #connections = new Map<string, ConnectionEntry>();
  readonly #failedCloseEntries = new Map<string, ConnectionEntry>();
  readonly #openFailures = new Map<string, Error>();
  readonly #failureFences = new LedgerFailureFences<ConnectionEntry>();

  constructor(rootDirectory: string, options: TranscriptLedgerStoreOptions = {}) {
    this.#rootDirectory = ensureLedgerRootDirectory(rootDirectory);
    this.#cacheSize = options.connectionCacheSize ?? DEFAULT_CONNECTION_CACHE_SIZE;
    if (!Number.isSafeInteger(this.#cacheSize) || this.#cacheSize < 1) {
      throw new TypeError('Ledger connection cache size must be a positive integer');
    }
    this.#createViewId = options.createViewId
      ?? (() => transcriptViewId(crypto.randomUUID()));
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#synchronous = options.synchronous ?? 'NORMAL';
  }

  currentView(chatId: string): TranscriptView | null {
    return this.#read(chatId, (entry) => entry.current);
  }
  existingCurrentView(chatId: string): TranscriptView | null {
    validateChatDirectoryName(chatId);
    if (this.#connections.has(chatId)
        || this.#openFailures.has(chatId)
        || this.#failureFences.hasReadFailure(chatId)) {
      return this.#read(chatId, (entry) => entry.current);
    }
    const databasePath = path.join(this.#rootDirectory, chatId, 'ledger.sqlite');
    if ((statSizeIfExists(databasePath) ?? 0) === 0) return null;
    return this.#read(chatId, (entry) => entry.current);
  }

  initializeCurrentView(chatId: string, input: InitializeViewInput): TranscriptView {
    validateContentStartOrdinal(input.contentStartOrdinal, input.rows?.length ?? 0);
    const viewId = input.viewId ?? this.#createViewId();
    const rows = input.rows ?? [];
    const encoded = encodeDrafts(rows);
    materializeRows(viewId, encoded, 1);
    return this.#write(chatId, (entry) => {
      if (entry.current) return entry.current;
      const createdAt = this.#now();
      runTransaction(entry.db, () => {
        entry.db.query(`
          INSERT INTO transcript_views(view_id, status, created_at, content_start_ordinal)
          VALUES (?, 'current', ?, ?)
        `).run(viewId, createdAt, input.contentStartOrdinal);
        insertEncodedRows(entry.db, viewId, encoded, 1);
      });
      entry.current = { viewId, status: 'current', createdAt, contentStartOrdinal: input.contentStartOrdinal };
      entry.nextOrdinal = rows.length + 1;
      return entry.current;
    });
  }

  append(
    chatId: string,
    expectedViewId: TranscriptViewId,
    drafts: readonly LedgerRowDraft[],
  ): readonly LedgerRow[] {
    if (drafts.length === 0) return [];
    const encoded = encodeDrafts(drafts);
    return this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, expectedViewId);
      const firstOrdinal = entry.nextOrdinal;
      const rows = materializeRows(expectedViewId, encoded, firstOrdinal);
      runTransaction(entry.db, () => {
        insertEncodedRows(entry.db, expectedViewId, encoded, firstOrdinal);
      });
      entry.nextOrdinal += drafts.length;
      return rows;
    });
  }

  hasMatchingInputSubmission(
    chatId: string,
    viewId: TranscriptViewId,
    detail: LedgerUserInputDetail,
  ): boolean {
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      return matchingInputSubmission(entry.db, viewId, detail) !== null;
    });
  }

  appendInputAndCompose(chatId: string, request: AppendInputRequest): InputComposition {
    return this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, request.viewId);
      const existing = matchingInputSubmission(entry.db, request.viewId, request.detail);
      if (existing) {
        return {
          input: existing,
          committedRows: [],
          prompt: [],
          providerPrefix: '',
          inserted: false,
        };
      }

      const prepared = preparePreambleInput({
        chatId,
        viewId: request.viewId,
        at: request.at,
        detail: request.detail,
        boundary: request.preambleBoundary,
        preambles: request.preambles,
      });
      const encoded = encodeDrafts(prepared.drafts);
      const firstOrdinal = entry.nextOrdinal;
      const committedRows = materializeRows(request.viewId, encoded, firstOrdinal);
      const input = committedRows[committedRows.length - 1] as LedgerUserInputRow;
      const prompt = runTransaction(entry.db, () => {
        insertEncodedRows(entry.db, request.viewId, encoded, firstOrdinal);
        return prepared.detail.steer
          ? [input]
          : this.#composePrompt(entry, request.viewId, input, request.excludedOrdinals);
      });
      entry.nextOrdinal += committedRows.length;
      return {
        input,
        committedRows,
        prompt,
        providerPrefix: prepared.providerPrefix,
        inserted: true,
      };
    });
  }

  hasPreambleBoundaryProof(chatId: string, boundary: PendingPreambleBoundary): boolean {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      return queryPreambleBoundaryProof(entry.db, current.viewId, boundary);
    });
  }

  appendChatRow(chatId: string, request: AppendChatRowRequest): AppendChatRowResult {
    const parsedDetail = parseLedgerCliRowNoticeDetail(request.detail);
    if (!parsedDetail) throw new TypeError('CLI row notice detail is required');
    const detail = {
      ...parsedDetail,
      title: parseChatRowTitle(parsedDetail.title) ?? null,
    };
    const message = parseChatRowContent(request.message);
    const draft: LedgerRowDraft = {
      kind: 'notice',
      at: request.at,
      message,
      detail,
      providerMeta: null,
    };
    const encoded = { draft, ...encodeLedgerDraft(draft) };
    return this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, request.viewId);
      const existing = readSubmission(
        entry.db,
        request.viewId,
        detail.clientMessageId,
      );
      if (existing) {
        if (
          !isLedgerCliRowNoticeRow(existing)
          || cliRowFingerprint(existing.message, existing.detail)
            !== cliRowFingerprint(message, detail)
        ) {
          throw new SubmissionConflictError(detail.clientMessageId);
        }
        return { row: existing, inserted: false };
      }

      const ordinal = entry.nextOrdinal;
      const [row] = materializeRows(request.viewId, [encoded], ordinal);
      runTransaction(entry.db, () => insertEncodedRows(entry.db, request.viewId, [encoded], ordinal));
      entry.nextOrdinal += 1;
      return { row: row as LedgerCliRowNoticeRow, inserted: true };
    });
  }

  // Idempotent by the private notice's clientMessageId in the current view's
  // submission index; the fingerprint proves retry identity.
  // Reads one submission-indexed row in the current view for identity checks
  // that must precede any mutation.
  findSubmissionRow(
    chatId: string,
    viewId: TranscriptViewId,
    clientMessageId: string,
  ): LedgerRow | null {
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      return readSubmission(entry.db, viewId, clientMessageId);
    });
  }

  appendSelectionChangeNotice(
    chatId: string,
    request: {
      readonly viewId: TranscriptViewId;
      readonly at: string;
      readonly detail: LedgerPreambleSelectionChangedNoticeDetail;
    },
  ): AppendSelectionChangeNoticeResult {
    const draft: LedgerRowDraft = {
      kind: 'notice',
      at: request.at,
      message: PREAMBLES_UPDATED_MESSAGE,
      detail: { ...request.detail, preambles: request.detail.preambles.map((p) => ({ ...p })) },
      providerMeta: null,
    };
    const encoded = { draft, ...encodeLedgerDraft(draft) };
    return this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, request.viewId);
      const existing = readSubmission(entry.db, request.viewId, request.detail.clientMessageId);
      if (existing) {
        if (
          !isLedgerPreambleSelectionChangedNoticeRow(existing)
          || existing.detail.requestFingerprint !== request.detail.requestFingerprint
        ) {
          throw new SubmissionConflictError(request.detail.clientMessageId);
        }
        return { row: existing, inserted: false };
      }
      const ordinal = entry.nextOrdinal;
      const [row] = materializeRows(request.viewId, [encoded], ordinal);
      runTransaction(entry.db, () => insertEncodedRows(entry.db, request.viewId, [encoded], ordinal));
      entry.nextOrdinal += 1;
      return { row: row as LedgerPreambleSelectionChangedNoticeRow, inserted: true };
    });
  }

  resendCandidates(chatId: string): readonly LedgerUserInputRow[] {
    return this.#read(chatId, (entry) => {
      const view = this.#requireCurrent(entry);
      const statement = entry.db.query<StoredLedgerRow, [string]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ?
        ORDER BY ordinal DESC
      `);
      try {
        return collectResendCandidates(statement.iterate(view.viewId));
      } finally {
        statement.finalize();
      }
    });
  }

  page(
    chatId: string,
    viewId: TranscriptViewId,
    limit: number,
    before?: number,
  ): TranscriptPage {
    const boundedLimit = normalizeLimit(limit);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      throw new TypeError('Transcript page cursor must be a positive integer');
    }
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      const stored = before === undefined
        ? entry.db.query<StoredLedgerRow, [string, number]>(`
            SELECT view_id, ordinal, kind, at, client_message_id, payload_json
            FROM transcript_rows
            WHERE view_id = ?
            ORDER BY ordinal DESC
            LIMIT ?
          `).all(viewId, boundedLimit)
        : entry.db.query<StoredLedgerRow, [string, number, number]>(`
            SELECT view_id, ordinal, kind, at, client_message_id, payload_json
            FROM transcript_rows
            WHERE view_id = ? AND ordinal < ?
            ORDER BY ordinal DESC
            LIMIT ?
          `).all(viewId, before, boundedLimit);
      const rows = stored.map(decodeStoredLedgerRow).reverse();
      const oldest = rows[0]?.ordinal ?? null;
      return {
        viewId,
        rows,
        nextBefore: oldest !== null && oldest > 1 ? oldest : null,
      };
    });
  }

  rowsAfter(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    kind?: LedgerRow['kind'],
  ): readonly LedgerRow[] {
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
      throw new TypeError('Transcript replay cursor must be a non-negative integer');
    }
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      const highWatermark = entry.nextOrdinal - 1;
      if (afterOrdinal > highWatermark) {
        throw new TypeError('Transcript replay cursor is ahead of the current view');
      }
      const params: (string | number)[] = kind === undefined ? [viewId, afterOrdinal] : [viewId, afterOrdinal, kind];
      return entry.db.query<StoredLedgerRow, (string | number)[]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal > ?${kind === undefined ? '' : ' AND kind = ?'}
        ORDER BY ordinal
      `).all(...params).map(decodeStoredLedgerRow);
    });
  }

  replayRows(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    throughOrdinal: number,
    limit: number,
  ): readonly LedgerRow[] {
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
      throw new TypeError('Transcript replay cursor must be a non-negative integer');
    }
    if (!Number.isSafeInteger(throughOrdinal) || throughOrdinal < afterOrdinal) {
      throw new TypeError('Transcript replay watermark must not precede its cursor');
    }
    const boundedLimit = normalizeLimit(limit);
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      const highWatermark = entry.nextOrdinal - 1;
      if (throughOrdinal > highWatermark) {
        throw new TypeError('Transcript replay watermark is ahead of the current view');
      }
      return entry.db.query<StoredLedgerRow, [string, number, number, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal > ? AND ordinal <= ?
        ORDER BY ordinal
        LIMIT ?
      `).all(viewId, afterOrdinal, throughOrdinal, boundedLimit).map(decodeStoredLedgerRow);
    });
  }

  rowsThrough(
    chatId: string,
    watermark: TranscriptWatermark,
  ): readonly LedgerRow[] {
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, watermark.viewId);
      if (!Number.isSafeInteger(watermark.ordinal) || watermark.ordinal < 0) {
        throw new TypeError('Transcript watermark ordinal is invalid');
      }
      return entry.db.query<StoredLedgerRow, [string, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal <= ?
        ORDER BY ordinal
      `).all(watermark.viewId, watermark.ordinal).map(decodeStoredLedgerRow);
    });
  }

  assistantMessagesForSubmission(
    chatId: string,
    viewId: TranscriptViewId,
    clientMessageId: string,
    throughOrdinal: number,
  ): readonly string[] {
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      const input = readSubmission(entry.db, viewId, clientMessageId);
      if (input?.kind !== 'user-input' || input.ordinal >= throughOrdinal) return [];
      return entry.db.query<StoredLedgerRow, [string, number, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal > ? AND ordinal < ? AND kind = 'provider-row'
        ORDER BY ordinal
      `).all(viewId, input.ordinal, throughOrdinal)
        .map(decodeStoredLedgerRow)
        .flatMap((row) => (
          row.kind === 'provider-row' && row.message.type === 'assistant-message'
            ? [row.message.content]
            : []
        ));
    });
  }

  currentRows(chatId: string): readonly LedgerRow[] {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      return entry.db.query<StoredLedgerRow, [string]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows WHERE view_id = ? ORDER BY ordinal
      `).all(current.viewId).map(decodeStoredLedgerRow);
    });
  }

  currentSession(chatId: string): LedgerSessionRow | null {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      return this.#currentSession(entry, current);
    });
  }

  nativeActivityState(chatId: string): TranscriptNativeActivityState {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      const session = this.#currentSession(entry, current);
      const watermark = readProviderActivityWatermark(
        entry.db,
        current.viewId,
        current.contentStartOrdinal,
      );
      return {
        viewId: current.viewId,
        session,
        providerWatermark: watermark,
      };
    });
  }

  highWatermark(chatId: string): TranscriptWatermark {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      return { viewId: current.viewId, ordinal: entry.nextOrdinal - 1 };
    });
  }

  stageView(chatId: string, input: StageViewInput): TranscriptView {
    validateContentStartOrdinal(input.contentStartOrdinal, input.rows?.length ?? 0);
    const rows = input.rows ?? [];
    const encoded = encodeDrafts(rows);
    materializeRows(input.viewId, encoded, 1);
    return this.#write(chatId, (entry) => {
      this.#requireCurrent(entry);
      const createdAt = this.#now();
      runTransaction(entry.db, () => {
        entry.db.query("DELETE FROM transcript_views WHERE status = 'staging'").run();
        entry.db.query(`
          INSERT INTO transcript_views(view_id, status, created_at, content_start_ordinal)
          VALUES (?, 'staging', ?, ?)
        `).run(input.viewId, createdAt, input.contentStartOrdinal);
        insertEncodedRows(entry.db, input.viewId, encoded, 1);
      });
      return {
        viewId: input.viewId,
        status: 'staging',
        createdAt,
        contentStartOrdinal: input.contentStartOrdinal,
      };
    });
  }

  discardStagingView(chatId: string, viewId: TranscriptViewId): void {
    this.#write(chatId, (entry) => {
      entry.db.query("DELETE FROM transcript_views WHERE status = 'staging' AND view_id = ?").run(viewId);
    });
  }

  replaceCurrentView(
    chatId: string,
    expectedCurrentViewId: TranscriptViewId,
    stagingViewId: TranscriptViewId,
  ): TranscriptView {
    return this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, expectedCurrentViewId);
      const staging = viewRecord(entry.db, stagingViewId, 'staging');
      if (!staging) throw new LedgerSchemaError('Transcript staging view is missing');
      const stagingNextOrdinal = nextOrdinal(entry.db, stagingViewId);
      runTransaction(entry.db, () => {
        entry.db.query("DELETE FROM transcript_views WHERE status = 'current' AND view_id = ?")
          .run(expectedCurrentViewId);
        const result = entry.db.query(
          "UPDATE transcript_views SET status = 'current' WHERE status = 'staging' AND view_id = ?",
        ).run(stagingViewId);
        if (result.changes !== 1) throw new LedgerSchemaError('Transcript staging promotion failed');
      });
      const current = toView({ ...staging, status: 'current' });
      entry.current = current;
      entry.nextOrdinal = stagingNextOrdinal;
      return current;
    });
  }

  advanceContentStart(
    chatId: string,
    viewId: TranscriptViewId,
    contentStartOrdinal: number,
  ): TranscriptView {
    return this.#write(chatId, (entry) => {
      const current = this.#assertCurrent(entry, viewId);
      if (!Number.isSafeInteger(contentStartOrdinal)
          || contentStartOrdinal < current.contentStartOrdinal
          || contentStartOrdinal > entry.nextOrdinal) {
        throw new TypeError('Content-start ordinal is outside the current transcript');
      }
      entry.db.query(`
        UPDATE transcript_views SET content_start_ordinal = ?
        WHERE view_id = ? AND status = 'current'
      `).run(contentStartOrdinal, viewId);
      entry.current = { ...current, contentStartOrdinal };
      return entry.current;
    });
  }

  checkpointForHandoff(chatId: string): LedgerCheckpoint {
    return this.#write(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      const result = runQuery(() => entry.db.query<{
        busy: number;
        log: number;
        checkpointed: number;
      }, []>('PRAGMA wal_checkpoint(FULL)').get());
      if (!result) throw new LedgerSchemaError('Transcript checkpoint returned no result');
      if (result.busy !== 0 || result.log !== result.checkpointed) {
        throw new IncompleteLedgerCheckpointError(result.busy, result.log, result.checkpointed);
      }
      return {
        viewId: current.viewId,
        ordinal: entry.nextOrdinal - 1,
        logFrames: result.log,
        checkpointedFrames: result.checkpointed,
      };
    });
  }

  closeChat(chatId: string): void {
    const entry = this.#connections.get(chatId) ?? this.#failedCloseEntries.get(chatId);
    if (!entry) return;
    this.#connections.delete(chatId);
    const failure = this.#closeConnectionEntry(entry);
    if (failure) throw failure;
  }

  deleteChat(chatId: string): void {
    validateChatDirectoryName(chatId);
    this.closeChat(chatId);
    this.#openFailures.delete(chatId);
    this.#failureFences.delete(chatId);
    rmSync(path.join(this.#rootDirectory, chatId), { recursive: true, force: true });
  }

  removeUnregisteredChatDirectories(registeredChatIds: ReadonlySet<string>): readonly string[] {
    const removed: string[] = [];
    if (statSizeIfExists(this.#rootDirectory) === null) return removed;
    for (const name of readdirSync(this.#rootDirectory)) {
      if (!CHAT_DIRECTORY_PATTERN.test(name) || registeredChatIds.has(name)) continue;
      const directory = path.join(this.#rootDirectory, name);
      const stats = lstatIfExists(directory);
      if (!stats) continue;
      const isDirectory = stats.isDirectory();
      if (!isDirectory && !stats.isSymbolicLink()) continue;
      if (isDirectory) {
        this.closeChat(name);
        this.#openFailures.delete(name);
        this.#failureFences.delete(name);
      }
      rmSync(directory, { recursive: isDirectory, force: true });
      removed.push(name);
    }
    return removed;
  }

  close(): void {
    const entries = new Map(this.#failedCloseEntries);
    for (const [chatId, entry] of this.#connections) entries.set(chatId, entry);
    this.#connections.clear();
    let firstFailure: Error | null = null;
    for (const entry of entries.values()) {
      const failure = this.#closeConnectionEntry(entry);
      if (!firstFailure && failure) firstFailure = failure;
    }
    if (this.#failedCloseEntries.size === 0) {
      this.#openFailures.clear();
      this.#failureFences.clear();
    }
    if (firstFailure) throw firstFailure;
  }

  #composePrompt(
    entry: ConnectionEntry,
    viewId: TranscriptViewId,
    current: LedgerUserInputRow,
    excludedOrdinals: ReadonlySet<number> | undefined,
  ): readonly LedgerUserInputRow[] {
    return runQuery(() => {
      const statement = entry.db.query<StoredLedgerRow, [string, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal < ?
        ORDER BY ordinal DESC
      `);
      try {
        const preceding = collectResendCandidates(
          statement.iterate(viewId, current.ordinal),
          excludedOrdinals,
        );
        return [...preceding, current];
      } finally {
        statement.finalize();
      }
    });
  }

  #currentSession(entry: ConnectionEntry, current: TranscriptView): LedgerSessionRow | null {
    const stored = entry.db.query<StoredLedgerRow, [string, number]>(`
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND ordinal >= ? AND kind = 'session'
      ORDER BY ordinal DESC LIMIT 1
    `).get(current.viewId, current.contentStartOrdinal);
    return stored ? decodeStoredLedgerRow(stored) as LedgerSessionRow : null;
  }

  #read<T>(chatId: string, work: (entry: ConnectionEntry) => T): T {
    return this.#failureFences.read(chatId, () => this.#availableConnection(chatId), work);
  }
  #write<T>(chatId: string, work: (entry: ConnectionEntry) => T): T {
    return this.#failureFences.write(
      chatId,
      () => this.#availableConnection(chatId),
      work,
      rehydrateConnection,
    );
  }

  #availableConnection(chatId: string): ConnectionEntry {
    const openFailure = this.#openFailures.get(chatId);
    if (openFailure) throw new LedgerFencedError(chatId, { cause: openFailure });
    try {
      return this.#connection(chatId);
    } catch (error) {
      const failure = asError(error);
      this.#openFailures.set(chatId, failure);
      throw new LedgerFencedError(chatId, { cause: failure });
    }
  }

  #connection(chatId: string): ConnectionEntry {
    validateChatDirectoryName(chatId);
    const cached = this.#connections.get(chatId);
    if (cached) {
      this.#connections.delete(chatId);
      this.#connections.set(chatId, cached);
      return cached;
    }
    const opened = openConnection(
      this.#rootDirectory,
      chatId,
      this.#synchronous,
    );
    this.#connections.set(chatId, opened);
    while (this.#connections.size > this.#cacheSize) {
      const oldest = this.#connections.entries().next().value as [string, ConnectionEntry] | undefined;
      if (!oldest) break;
      this.#connections.delete(oldest[0]);
      const failure = this.#closeConnectionEntry(oldest[1]);
      if (failure) logger.error('Ledger connection eviction failed; chat is fenced', oldest[0], failure);
    }
    return opened;
  }

  #closeConnectionEntry(entry: ConnectionEntry): Error | null {
    const attempt = closeConnection(entry);
    if (attempt.closed) {
      this.#failedCloseEntries.delete(entry.chatId);
      // Treats a passive checkpoint failure as housekeeping once the database closes.
      if (attempt.checkpointFailure) logger.warn('Passive checkpoint failed on ledger close', entry.chatId, attempt.checkpointFailure);
      return null;
    }
    this.#failedCloseEntries.set(entry.chatId, entry);
    this.#openFailures.set(entry.chatId, attempt.failure);
    return attempt.failure;
  }

  #requireCurrent(entry: ConnectionEntry): TranscriptView {
    if (!entry.current) throw new TranscriptViewNotInitializedError(entry.chatId);
    return entry.current;
  }

  #assertCurrent(entry: ConnectionEntry, expected: TranscriptViewId): TranscriptView {
    const current = this.#requireCurrent(entry);
    if (current.viewId !== expected) {
      throw new StaleTranscriptViewError(entry.chatId, expected, current.viewId);
    }
    return current;
  }
}

interface EncodedDraft {
  readonly draft: LedgerRowDraft;
  readonly clientMessageId: string | null;
  readonly payloadJson: string;
}

function encodeDrafts(drafts: readonly LedgerRowDraft[]): readonly EncodedDraft[] {
  const encoded = drafts.map((draft) => ({ draft, ...encodeLedgerDraft(draft) }));
  const clientMessageIds = new Set<string>();
  for (const row of encoded) {
    if (!row.clientMessageId) continue;
    if (clientMessageIds.has(row.clientMessageId)) {
      throw new LedgerSchemaError('Transcript view contains duplicate client message IDs');
    }
    clientMessageIds.add(row.clientMessageId);
  }
  return encoded;
}

function materializeRows(
  viewId: TranscriptViewId,
  rows: readonly EncodedDraft[],
  firstOrdinal: number,
): readonly LedgerRow[] {
  return rows.map((item, index) => decodeLedgerRow({
    view_id: viewId,
    ordinal: firstOrdinal + index,
    kind: item.draft.kind,
    at: item.draft.at,
    client_message_id: item.clientMessageId,
    payload_json: item.payloadJson,
  }));
}

function collectResendCandidates(
  storedRows: Iterable<StoredLedgerRow>,
  excludedOrdinals?: ReadonlySet<number>,
): readonly LedgerUserInputRow[] {
  const candidates: LedgerUserInputRow[] = [];
  for (const stored of storedRows) {
    const row = decodeStoredLedgerRow(stored);
    if (row.kind === 'user-input') {
      if (!excludedOrdinals?.has(row.ordinal)) candidates.unshift(row);
      continue;
    }
    if (row.kind === 'run-ended' && row.outcome === 'interrupted') continue;
    if (isPresentationOnlyProviderRow(row)) continue;
    if (row.kind === 'provider-row'
        || row.kind === 'permission-requested'
        || row.kind === 'run-ended') break;
  }
  return candidates;
}

function insertEncodedRows(
  db: Database,
  viewId: TranscriptViewId,
  rows: readonly EncodedDraft[],
  firstOrdinal: number,
): void {
  const insert = db.query(`
    INSERT INTO transcript_rows(
      view_id, ordinal, kind, at, client_message_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  rows.forEach((row, index) => {
    insert.run(
      viewId,
      firstOrdinal + index,
      row.draft.kind,
      row.draft.at,
      row.clientMessageId,
      row.payloadJson,
    );
  });
}


function validateChatDirectoryName(chatId: string): void {
  if (!CHAT_DIRECTORY_PATTERN.test(chatId)) {
    throw new TypeError('Chat ID is not a safe ledger directory name');
  }
}

function validateContentStartOrdinal(value: number, rowCount: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > rowCount + 1) {
    throw new TypeError('Content-start ordinal must address the view or its append boundary');
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('Transcript page limit must be between 1 and 1000');
  }
  return limit;
}
