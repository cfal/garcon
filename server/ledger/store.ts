import { Database } from 'bun:sqlite';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import {
  decodeLedgerRow,
  encodeLedgerDraft,
  submissionFingerprint,
  type StoredLedgerRow,
} from './codec.js';
import type {
  InputComposition,
  LedgerCheckpoint,
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
import { transcriptViewId } from './contracts.js';
import {
  IncompleteLedgerCheckpointError,
  LedgerError,
  LedgerFencedError,
  LedgerSchemaError,
  StaleTranscriptViewError,
  SubmissionConflictError,
  TranscriptViewNotInitializedError,
} from './errors.js';

const LEDGER_SCHEMA_VERSION = 1;
const DEFAULT_CONNECTION_CACHE_SIZE = 10;
const CHAT_DIRECTORY_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ViewRecord {
  readonly view_id: string;
  readonly status: 'current' | 'staging';
  readonly created_at: string;
  readonly content_start_ordinal: number;
}

interface ConnectionEntry {
  readonly chatId: string;
  readonly directory: string;
  readonly db: Database;
  current: TranscriptView | null;
  nextOrdinal: number;
  fenced: Error | null;
}

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

export interface AppendInputRequest {
  readonly viewId: TranscriptViewId;
  readonly at: string;
  readonly detail: LedgerUserInputDetail;
  readonly excludedOrdinals?: ReadonlySet<number>;
}

export class TranscriptLedgerStore {
  readonly #rootDirectory: string;
  readonly #cacheSize: number;
  readonly #createViewId: () => TranscriptViewId;
  readonly #now: () => string;
  readonly #synchronous: 'NORMAL' | 'FULL';
  readonly #connections = new Map<string, ConnectionEntry>();
  readonly #openFailures = new Map<string, Error>();

  constructor(rootDirectory: string, options: TranscriptLedgerStoreOptions = {}) {
    this.#rootDirectory = rootDirectory;
    this.#cacheSize = options.connectionCacheSize ?? DEFAULT_CONNECTION_CACHE_SIZE;
    if (!Number.isSafeInteger(this.#cacheSize) || this.#cacheSize < 1) {
      throw new TypeError('Ledger connection cache size must be a positive integer');
    }
    this.#createViewId = options.createViewId
      ?? (() => transcriptViewId(crypto.randomUUID()));
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#synchronous = options.synchronous ?? 'NORMAL';
    mkdirSync(this.#rootDirectory, { recursive: true, mode: 0o700 });
  }

  currentView(chatId: string): TranscriptView | null {
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

  appendInputAndCompose(chatId: string, request: AppendInputRequest): InputComposition {
    validateInputDetail(request.detail);
    const draft: LedgerRowDraft = {
      kind: 'user-input',
      at: request.at,
      detail: request.detail,
      providerMeta: null,
    };
    const encoded = { draft, ...encodeLedgerDraft(draft) };
    return this.#write(chatId, (entry) => {
      this.#assertCurrent(entry, request.viewId);
      const existing = request.detail.clientMessageId
        ? this.#submission(entry, request.viewId, request.detail.clientMessageId)
        : null;
      if (existing) {
        if (existing.kind !== 'user-input'
            || submissionFingerprint(existing.detail) !== submissionFingerprint(request.detail)) {
          throw new SubmissionConflictError(request.detail.clientMessageId!);
        }
        return { input: existing, prompt: [], inserted: false };
      }

      const ordinal = entry.nextOrdinal;
      const [materialized] = materializeRows(
        request.viewId,
        [encoded],
        ordinal,
      );
      const input = materialized as LedgerUserInputRow;
      const prompt = runTransaction(entry.db, () => {
        insertEncodedRows(entry.db, request.viewId, [encoded], ordinal);
        return request.detail.steer
          ? [input]
          : this.#composePrompt(entry, request.viewId, input, request.excludedOrdinals);
      });
      entry.nextOrdinal += 1;
      return { input, prompt, inserted: true };
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
      const rows = stored.map(decodeStoredRow).reverse();
      const oldest = rows[0]?.ordinal ?? null;
      const hasOlder = oldest !== null && Boolean(entry.db.query<{ found: number }, [string, number]>(`
        SELECT 1 AS found FROM transcript_rows
        WHERE view_id = ? AND ordinal < ? LIMIT 1
      `).get(viewId, oldest));
      return { viewId, rows, nextBefore: hasOlder ? oldest : null };
    });
  }

  rowsAfter(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
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
      return entry.db.query<StoredLedgerRow, [string, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal > ?
        ORDER BY ordinal
      `).all(viewId, afterOrdinal).map(decodeStoredRow);
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
      `).all(watermark.viewId, watermark.ordinal).map(decodeStoredRow);
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
      const input = this.#submission(entry, viewId, clientMessageId);
      if (input?.kind !== 'user-input' || input.ordinal >= throughOrdinal) return [];
      return entry.db.query<StoredLedgerRow, [string, number, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal > ? AND ordinal < ? AND kind = 'provider-row'
        ORDER BY ordinal
      `).all(viewId, input.ordinal, throughOrdinal)
        .map(decodeStoredRow)
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
      `).all(current.viewId).map(decodeStoredRow);
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
      const watermark = entry.db.query<{ at: string }, [string, number]>(`
        SELECT at
        FROM transcript_rows
        WHERE view_id = ? AND ordinal >= ? AND (
          kind IN (
            'provider-row',
            'session',
            'permission-requested',
            'permission-cancelled',
            'permission-expired'
          )
          OR (
            kind = 'run-ended'
            AND json_extract(payload_json, '$.value.origin') = 'provider'
          )
          OR (
            kind = 'user-input'
            AND client_message_id IS NULL
          )
        )
        ORDER BY ordinal DESC LIMIT 1
      `).get(current.viewId, current.contentStartOrdinal);
      const notice = entry.db.query<StoredLedgerRow, [string, number, string]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ?
          AND ordinal >= ?
          AND kind = 'notice'
          AND json_extract(payload_json, '$.value.detail.type') = ?
        ORDER BY ordinal DESC LIMIT 1
      `).get(current.viewId, current.contentStartOrdinal, 'native-transcript-drift');
      const noticeRow = notice ? decodeStoredRow(notice) : null;
      const noticeWatermark = noticeRow?.kind === 'notice'
        && typeof noticeRow.detail.observedNativeWatermark === 'string'
        ? noticeRow.detail.observedNativeWatermark
        : null;
      return {
        viewId: current.viewId,
        session,
        providerWatermarkAt: watermark?.at ?? null,
        lastNoticeWatermarkAt: noticeWatermark,
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
      entry.nextOrdinal = nextOrdinal(entry.db, current.viewId);
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
    return this.#read(chatId, (entry) => {
      const current = this.#requireCurrent(entry);
      const result = entry.db.query<{
        busy: number;
        log: number;
        checkpointed: number;
      }, []>('PRAGMA wal_checkpoint(FULL)').get();
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
    const entry = this.#connections.get(chatId);
    if (!entry) return;
    this.#connections.delete(chatId);
    closeConnection(entry);
  }

  deleteChat(chatId: string): void {
    validateChatDirectoryName(chatId);
    this.closeChat(chatId);
    this.#openFailures.delete(chatId);
    rmSync(path.join(this.#rootDirectory, chatId), { recursive: true, force: true });
  }

  removeUnregisteredChatDirectories(registeredChatIds: ReadonlySet<string>): readonly string[] {
    const removed: string[] = [];
    if (!existsSync(this.#rootDirectory)) return removed;
    for (const name of readdirSync(this.#rootDirectory)) {
      if (!CHAT_DIRECTORY_PATTERN.test(name) || registeredChatIds.has(name)) continue;
      const directory = path.join(this.#rootDirectory, name);
      if (!statSync(directory).isDirectory()) continue;
      this.closeChat(name);
      this.#openFailures.delete(name);
      rmSync(directory, { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }

  close(): void {
    for (const entry of this.#connections.values()) closeConnection(entry);
    this.#connections.clear();
    this.#openFailures.clear();
  }

  #composePrompt(
    entry: ConnectionEntry,
    viewId: TranscriptViewId,
    current: LedgerUserInputRow,
    excludedOrdinals: ReadonlySet<number> | undefined,
  ): readonly LedgerUserInputRow[] {
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
  }

  #currentSession(entry: ConnectionEntry, current: TranscriptView): LedgerSessionRow | null {
    const stored = entry.db.query<StoredLedgerRow, [string, number]>(`
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND ordinal >= ? AND kind = 'session'
      ORDER BY ordinal DESC LIMIT 1
    `).get(current.viewId, current.contentStartOrdinal);
    return stored ? decodeStoredRow(stored) as LedgerSessionRow : null;
  }

  #submission(
    entry: ConnectionEntry,
    viewId: TranscriptViewId,
    clientMessageId: string,
  ): LedgerRow | null {
    const stored = entry.db.query<StoredLedgerRow, [string, string]>(`
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND client_message_id = ?
    `).get(viewId, clientMessageId);
    return stored ? decodeStoredRow(stored) : null;
  }

  #read<T>(chatId: string, work: (entry: ConnectionEntry) => T): T {
    const openFailure = this.#openFailures.get(chatId);
    if (openFailure) throw new LedgerFencedError(chatId, { cause: openFailure });
    let entry: ConnectionEntry;
    try {
      entry = this.#connection(chatId);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#openFailures.set(chatId, failure);
      throw new LedgerFencedError(chatId, { cause: failure });
    }
    if (entry.fenced) throw new LedgerFencedError(chatId, { cause: entry.fenced });
    try {
      return work(entry);
    } catch (error) {
      if (isDomainError(error)) throw error;
      entry.fenced = error instanceof Error ? error : new Error(String(error));
      throw new LedgerFencedError(chatId, { cause: entry.fenced });
    }
  }

  #write<T>(chatId: string, work: (entry: ConnectionEntry) => T): T {
    return this.#read(chatId, work);
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
      closeConnection(oldest[1]);
    }
    return opened;
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

function decodeStoredRow(row: StoredLedgerRow): LedgerRow {
  try {
    return decodeLedgerRow(row);
  } catch (error) {
    throw new Error('Stored transcript row is invalid', { cause: error });
  }
}

function collectResendCandidates(
  storedRows: Iterable<StoredLedgerRow>,
  excludedOrdinals?: ReadonlySet<number>,
): readonly LedgerUserInputRow[] {
  const candidates: LedgerUserInputRow[] = [];
  for (const stored of storedRows) {
    const row = decodeStoredRow(stored);
    if (row.kind === 'user-input') {
      if (!excludedOrdinals?.has(row.ordinal)) candidates.unshift(row);
      continue;
    }
    if (row.kind === 'run-ended' && row.outcome === 'interrupted') continue;
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

function openConnection(
  rootDirectory: string,
  chatId: string,
  synchronous: 'NORMAL' | 'FULL',
): ConnectionEntry {
  const directory = path.join(rootDirectory, chatId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(directory, 'ledger.sqlite');
  const existed = existsSync(databasePath) && statSync(databasePath).size > 0;
  const db = new Database(databasePath);
  try {
    configureConnection(db, synchronous);
    if (!existed) createSchema(db);
    else validateSchema(db);
    const current = loadAndCleanViews(db);
    chmodSync(databasePath, 0o600);
    return {
      chatId,
      directory,
      db,
      current,
      nextOrdinal: current ? nextOrdinal(db, current.viewId) : 1,
      fenced: null,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function configureConnection(db: Database, synchronous: 'NORMAL' | 'FULL'): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

function createSchema(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      CREATE TABLE transcript_views (
        view_id               TEXT PRIMARY KEY,
        status                TEXT NOT NULL CHECK (status IN ('current', 'staging')),
        created_at            TEXT NOT NULL,
        content_start_ordinal INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX transcript_one_current
        ON transcript_views(status)
        WHERE status = 'current';

      CREATE TABLE transcript_rows (
        view_id           TEXT NOT NULL
                          REFERENCES transcript_views(view_id) ON DELETE CASCADE,
        ordinal           INTEGER NOT NULL,
        kind              TEXT NOT NULL,
        at                TEXT NOT NULL,
        client_message_id TEXT,
        payload_json      TEXT NOT NULL,
        PRIMARY KEY (view_id, ordinal)
      ) WITHOUT ROWID, STRICT;

      CREATE UNIQUE INDEX transcript_submission
        ON transcript_rows(view_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
    `);
    db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
  });
}

function validateSchema(db: Database): void {
  const version = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);
  if (version !== LEDGER_SCHEMA_VERSION) {
    throw new LedgerSchemaError(`Unsupported transcript ledger schema version ${version}`);
  }
  const required = new Set(['transcript_views', 'transcript_rows']);
  const records = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('transcript_views', 'transcript_rows')
  `).all();
  for (const record of records) required.delete(record.name);
  if (required.size > 0) throw new LedgerSchemaError('Transcript ledger schema is incomplete');
}

function loadAndCleanViews(db: Database): TranscriptView | null {
  const views = db.query<ViewRecord, []>(`
    SELECT view_id, status, created_at, content_start_ordinal
    FROM transcript_views
  `).all();
  const current = views.filter((view) => view.status === 'current');
  if (current.length !== 1 && views.length > 0) {
    throw new LedgerSchemaError('Established transcript ledger must have exactly one current view');
  }
  if (views.some((view) => view.status === 'staging')) {
    db.query("DELETE FROM transcript_views WHERE status = 'staging'").run();
  }
  return current[0] ? toView(current[0]) : null;
}

function viewRecord(
  db: Database,
  viewId: TranscriptViewId,
  status: 'current' | 'staging',
): ViewRecord | null {
  return db.query<ViewRecord, [string, string]>(`
    SELECT view_id, status, created_at, content_start_ordinal
    FROM transcript_views WHERE view_id = ? AND status = ?
  `).get(viewId, status) ?? null;
}

function toView(record: ViewRecord): TranscriptView {
  return {
    viewId: transcriptViewId(record.view_id),
    status: record.status,
    createdAt: record.created_at,
    contentStartOrdinal: record.content_start_ordinal,
  };
}

function nextOrdinal(db: Database, viewId: TranscriptViewId): number {
  const row = db.query<{ maximum: number | null }, [string]>(`
    SELECT max(ordinal) AS maximum FROM transcript_rows WHERE view_id = ?
  `).get(viewId);
  return (row?.maximum ?? 0) + 1;
}

function runTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function closeConnection(entry: ConnectionEntry): void {
  try {
    entry.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } finally {
    entry.db.close();
  }
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

function validateInputDetail(detail: LedgerUserInputDetail): void {
  if (detail.clientMessageId !== null && detail.clientMessageId.length === 0) {
    throw new TypeError('Client message ID must be non-empty');
  }
  if (!detail.message || detail.message.type !== 'user-message') {
    throw new TypeError('Input detail requires a user message');
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('Transcript page limit must be between 1 and 1000');
  }
  return limit;
}

function isDomainError(error: unknown): error is LedgerError | TypeError {
  return error instanceof LedgerError || error instanceof TypeError;
}
