import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { yieldToEventLoop } from '@garcon/server-agent-common/shared/event-loop';
import { trackActivity } from '../../common/event-loop-stalls.js';
import {
  encodeDrafts,
  insertEncodedRows,
  materializeRows,
  promoteStagingView,
  readBoundedPage,
  readBoundedStoredPage,
  StagingViews,
  type BoundedPage,
} from './staging-views.js';
import {
  parseChatRowContent,
  parseChatRowTitle,
} from '../../../common/chat-row-contracts.js';
import { createLogger } from '../../common/log.js';
import { hasNodeErrorCode } from '../../common/errors.js';
import {
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
  UNDECODABLE_LEDGER_ROW,
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
import { findCurrentSession } from './session-query.js';
import {
  asError,
  nextOrdinal,
  runQuery,
  runTransaction,
} from './sqlite-operations.js';
import type { PendingPreambleBoundary } from '../../../common/preambles.js';
import {
  hasPreambleBoundaryProof as queryPreambleBoundaryProof,
  preparePreambleInput,
} from './preamble-application.js';
import { matchingInputSubmission, readSubmission } from './input-submission.js';
import { findTicketOutcomeOrdinal } from './ticket-outcome-query.js';

const DEFAULT_CONNECTION_CACHE_SIZE = 10;
const PREVIEW_EDGE_ROWS = 32;
const PREVIEW_ROW_BYTES = 64 * 1024;
const CHAT_DIRECTORY_PATTERN = /^[A-Za-z0-9_-]+$/;
// Deleted chat directories wait here for asynchronous removal. The leading dot keeps it
// outside CHAT_DIRECTORY_PATTERN.
const TRASH_DIRECTORY = '.trash';
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

export type StoredRowsWork<T> = (rows: readonly StoredLedgerRow[]) => Promise<T>;
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
  readonly #staging: StagingViews;

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
    this.#staging = new StagingViews((chatId, work) => this.#write(chatId, work));
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

  // Initializes a chat from a possibly long history. Rows commit under an inert staging view
  // in bounded transactions; one small promotion exposes the complete view. An existing
  // current view wins, as in initializeCurrentView.
  async seedCurrentView(chatId: string, input: InitializeViewInput): Promise<TranscriptView> {
    validateContentStartOrdinal(input.contentStartOrdinal, input.rows?.length ?? 0);
    const rows = input.rows ?? [];
    if (this.#staging.fitsOneTransaction(rows)) return this.initializeCurrentView(chatId, input);
    const viewId = input.viewId ?? this.#createViewId();
    const generation = this.#staging.generation(chatId);
    const existing = this.#read(chatId, (entry) => entry.current);
    if (existing) return existing;
    const createdAt = this.#now();
    this.#staging.begin(chatId, viewId, input.contentStartOrdinal, createdAt);
    let promoted: TranscriptView | null = null;
    try {
      await this.#staging.insertRows(chatId, viewId, rows, generation);
      promoted = this.#write(chatId, (entry) => {
        if (entry.current) return null;
        runTransaction(entry.db, () => promoteStagingView(entry.db, viewId));
        entry.current = { viewId, status: 'current', createdAt, contentStartOrdinal: input.contentStartOrdinal };
        entry.nextOrdinal = rows.length + 1;
        return entry.current;
      });
    } finally {
      if (promoted) this.#staging.release(chatId, viewId);
      else await this.#staging.discard(chatId, viewId, generation);
    }
    return promoted ?? this.#read(chatId, (entry) => this.#requireCurrent(entry));
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

  ticketOutcomeOrdinal(chatId: string, viewId: TranscriptViewId, requestOrdinal: number): number | null {
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      return findTicketOutcomeOrdinal(entry.db, viewId, requestOrdinal);
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

  rowsThrough(chatId: string, watermark: TranscriptWatermark): Promise<readonly LedgerRow[]> {
    return this.#pagesThrough(chatId, watermark, readBoundedPage);
  }

  rowPagesThrough(chatId: string, watermark: TranscriptWatermark): AsyncIterable<readonly LedgerRow[]> {
    return this.#streamPages(chatId, watermark, readBoundedPage);
  }

  // Reads stored rows for work that decodes them after the read, such as on a Worker. A row
  // that fails to decode there fences the chat while its view is current, as a read that
  // decodes rows does.
  async withStoredRowsThrough<T>(chatId: string, watermark: TranscriptWatermark, work: StoredRowsWork<T>, signal?: AbortSignal): Promise<T> {
    const rows = await this.#pagesThrough(chatId, watermark, readBoundedStoredPage, signal);
    signal?.throwIfAborted();
    try {
      return await work(rows);
    } catch (error) {
      if (!hasNodeErrorCode(error, UNDECODABLE_LEDGER_ROW)) throw error;
      return this.#read(chatId, (entry) => {
        this.#assertCurrent(entry, watermark.viewId);
        throw error;
      });
    }
  }

  // Reads in bounded pages. Rows at or below a watermark never change, so pages taken across
  // event-loop turns form one consistent prefix; a replaced view fails as stale.
  async #pagesThrough<Row extends { readonly ordinal: number }>(
    chatId: string,
    watermark: TranscriptWatermark,
    readPage: (db: Database, viewId: TranscriptViewId, after: number, through: number) => BoundedPage<Row>,
    signal?: AbortSignal,
  ): Promise<readonly Row[]> {
    const rows: Row[] = [];
    for await (const page of this.#streamPages(chatId, watermark, readPage, signal)) rows.push(...page);
    return rows;
  }

  async *#streamPages<Row extends { readonly ordinal: number }>(
    chatId: string,
    watermark: TranscriptWatermark,
    readPage: (db: Database, viewId: TranscriptViewId, after: number, through: number) => BoundedPage<Row>,
    signal?: AbortSignal,
  ): AsyncGenerator<readonly Row[]> {
    if (!Number.isSafeInteger(watermark.ordinal) || watermark.ordinal < 0) {
      throw new TypeError('Transcript watermark ordinal is invalid');
    }
    let after = 0;
    for (;;) {
      signal?.throwIfAborted();
      const page = this.#read(chatId, (entry) => {
        this.#assertCurrent(entry, watermark.viewId);
        return readPage(entry.db, watermark.viewId, after, watermark.ordinal);
      });
      yield page.rows;
      signal?.throwIfAborted();
      if (page.exhausted) {
        this.#read(chatId, entry => this.#assertCurrent(entry, watermark.viewId));
        return;
      }
      after = page.rows[page.rows.length - 1]!.ordinal;
      await yieldToEventLoop();
    }
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

  // Bounds both the indexed ordinal ranges and JSON decoded for best-effort previews.
  previewEdges(chatId: string, viewId: TranscriptViewId): { head: LedgerRow[]; firstOmittedHeadOrdinal: number | null; tail: LedgerRow[] } {
    return this.#read(chatId, (entry) => {
      this.#assertCurrent(entry, viewId);
      const query = entry.db.query<Omit<StoredLedgerRow, 'payload_json'> & { payload_json: string | null }, [number, string, number, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id,
          CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json END AS payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal BETWEEN ? AND ?
          AND kind IN ('user-input', 'provider-row')
        ORDER BY ordinal
      `);
      const decode = (rows: ReturnType<typeof query.all>): LedgerRow[] => rows
        .flatMap((row) => row.payload_json === null ? [] : [decodeStoredLedgerRow({ ...row, payload_json: row.payload_json })]);
      const last = entry.nextOrdinal - 1;
      const head = query.all(PREVIEW_ROW_BYTES, viewId, 1, PREVIEW_EDGE_ROWS);
      return {
        head: decode(head),
        // An omitted payload could contain the first input, including imported user rows.
        firstOmittedHeadOrdinal: head.find((row) => row.payload_json === null)?.ordinal ?? null,
        tail: decode(query.all(PREVIEW_ROW_BYTES, viewId, Math.max(1, last - PREVIEW_EDGE_ROWS + 1), last)),
      };
    });
  }

  currentSession(chatId: string): LedgerSessionRow | null {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      return findCurrentSession(entry.db, current);
    });
  }

  nativeActivityState(chatId: string): TranscriptNativeActivityState {
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      const session = findCurrentSession(entry.db, current);
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

  // Stages a replacement view in bounded transactions. The view stays inert, and survives a
  // connection-cache reopen, until replaceCurrentView promotes it or it is discarded.
  async stageView(chatId: string, input: StageViewInput): Promise<TranscriptView> {
    validateContentStartOrdinal(input.contentStartOrdinal, input.rows?.length ?? 0);
    const rows = input.rows ?? [];
    const generation = this.#staging.generation(chatId);
    this.#read(chatId, (entry) => this.#requireCurrent(entry));
    const createdAt = this.#now();
    this.#staging.begin(chatId, input.viewId, input.contentStartOrdinal, createdAt);
    try {
      await this.#staging.insertRows(chatId, input.viewId, rows, generation);
    } catch (error) {
      await this.#staging.discard(chatId, input.viewId, generation);
      throw error;
    }
    return {
      viewId: input.viewId,
      status: 'staging',
      createdAt,
      contentStartOrdinal: input.contentStartOrdinal,
    };
  }

  async discardStagingView(chatId: string, viewId: TranscriptViewId): Promise<void> {
    await this.#staging.discard(chatId, viewId);
  }

  // Promotion is one small transaction. The replaced view is demoted to inert staging in the
  // same transaction and its rows are deleted afterwards in bounded steps; a crash first
  // leaves it for open-time cleanup, and it is never readable again either way.
  replaceCurrentView(
    chatId: string,
    expectedCurrentViewId: TranscriptViewId,
    stagingViewId: TranscriptViewId,
  ): TranscriptView {
    const current = this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, expectedCurrentViewId);
      const staging = viewRecord(entry.db, stagingViewId, 'staging');
      if (!staging) throw new LedgerSchemaError('Transcript staging view is missing');
      const stagingNextOrdinal = nextOrdinal(entry.db, stagingViewId);
      runTransaction(entry.db, () => {
        const demoted = entry.db.query(
          "UPDATE transcript_views SET status = 'staging' WHERE status = 'current' AND view_id = ?",
        ).run(expectedCurrentViewId);
        if (demoted.changes !== 1) throw new LedgerSchemaError('Transcript current view demotion failed');
        promoteStagingView(entry.db, stagingViewId);
      });
      const promoted = toView({ ...staging, status: 'current' });
      entry.current = promoted;
      entry.nextOrdinal = stagingNextOrdinal;
      return promoted;
    });
    this.#staging.release(chatId, stagingViewId);
    this.#staging.retain(chatId, expectedCurrentViewId);
    void this.#staging.discard(chatId, expectedCurrentViewId);
    return current;
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
    this.#staging.abandon(chatId);
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
    this.#discardDirectory(chatId);
  }

  // Also removes chat directories whose deletion a restart interrupted.
  removeUnregisteredChatDirectories(registeredChatIds: ReadonlySet<string> | null): readonly string[] {
    const removed: string[] = [];
    if (statSizeIfExists(this.#rootDirectory) === null) return removed;
    const names = readdirSync(this.#rootDirectory);
    if (registeredChatIds === null) {
      if (names.length > 0) {
        throw new Error('Missing chats.json with existing transcript ledgers; restore the registry before starting Garcon');
      }
      return removed;
    }
    void this.#sweepTrash();
    for (const name of names) {
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
        this.#discardDirectory(name);
      } else {
        rmSync(directory, { force: true });
      }
      removed.push(name);
    }
    return removed;
  }

  close(): void {
    this.#staging.abandonAll();
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

  // A rename within the ledger root is constant-time, so the chat's files disappear at
  // once, while unlinking a large ledger can take the filesystem a noticeable time, so the
  // removal runs off the event loop.
  #discardDirectory(name: string): void {
    const target = path.join(this.#trashDirectory(), `${name}-${crypto.randomUUID()}`);
    try {
      renameSync(path.join(this.#rootDirectory, name), target);
    } catch (error) {
      if (hasNodeErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    void this.#removeDeleted(target);
  }

  // Replaces anything but a real directory at the trash path, so removal never follows a link
  // out of the ledger root.
  #trashDirectory(): string {
    const trash = path.join(this.#rootDirectory, TRASH_DIRECTORY);
    const stats = lstatIfExists(trash);
    if (stats?.isDirectory()) return trash;
    if (stats) rmSync(trash, { force: true });
    mkdirSync(trash, { mode: 0o700 });
    return trash;
  }

  // Empties the trash entry by entry; removing the directory itself could race a rename into it.
  async #sweepTrash(): Promise<void> {
    const trash = path.join(this.#rootDirectory, TRASH_DIRECTORY);
    const stats = await lstat(trash).catch(() => null);
    if (!stats?.isDirectory()) return;
    const entries = await readdir(trash).catch(() => []);
    for (const entry of entries) await this.#removeDeleted(path.join(trash, entry));
  }

  async #removeDeleted(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      logger.warn('Deleted transcript ledger removal failed; it is retried on the next start', error);
    }
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
    // Opening can migrate the schema or delete a leftover view, both proportional to the ledger.
    const finishActivity = trackActivity('ledger open');
    let opened: ConnectionEntry;
    try {
      opened = openConnection(
        this.#rootDirectory,
        chatId,
        this.#synchronous,
        this.#staging.retained(chatId),
      );
    } finally {
      finishActivity();
    }
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
