import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { GhRepositoryIdentity, PullRequestSummary } from '../../../common/gh.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import { ghRepositoryIdentity } from '../../../common/gh-identity.js';
import {
  isActivePullRequestReviewRun,
  PULL_REQUEST_REVIEW_MAX_REPOSITORIES,
  PULL_REQUEST_REVIEW_RUN_PAGE_SIZE,
  type PullRequestReviewRepository,
  type PullRequestReviewRun,
  type PullRequestReviewRunState,
  type PullRequestReviewScan,
} from '../../../common/pull-request-reviews.js';
import { DomainError } from '../../common/domain-error.js';
import { diagnosticErrorCode } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import { configureDurableSqlite, openPrivateSqliteDatabase, securePrivateSqliteSidecars } from '../lib/private-sqlite.js';
import { reviewConflict, reviewStorageUnavailable } from './errors.js';
import { PENDING_REVIEW_POST_RECOVERY, PULL_REQUEST_REVIEW_SCHEMA } from './schema.js';

const logger = createLogger('pull-request-review-store');

export type StoredRepository = Omit<PullRequestReviewRepository, 'scan'>;

// A review run as stored. Projection to the browser contract adds chat availability.
export interface StoredRun extends Omit<PullRequestReviewRun, 'chatAvailable'> {
  turnId: string | null;
  // Set once the review chat was archived because its pull request left the open list.
  chatArchived: boolean;
}

export type StoredRunDetail = StoredRun & { review: string | null };

export interface ReviewRunCursor {
  createdAt: string;
  sequence: number;
}

export interface StoredRunPage {
  runs: StoredRun[];
  nextCursor: string | null;
}

function runPage(rows: (RunRow & { sequence: number })[]): StoredRunPage {
  const runs = rows.slice(0, PULL_REQUEST_REVIEW_RUN_PAGE_SIZE).map(runFromRow);
  const last = rows[runs.length - 1];
  return {
    runs,
    nextCursor: rows.length > runs.length && last ? JSON.stringify([last.created_at, last.sequence]) : null,
  };
}

export interface ReviewSelectionHistory {
  active: boolean;
  completed: boolean;
  stopped: boolean;
  attempts: number;
}

export const REVIEW_HISTORY_BATCH_SIZE = 100;

interface RunRow {
  id: string;
  repository_id: string;
  number: number;
  head_sha: string;
  state: PullRequestReviewRunState;
  created_at: string;
  payload_json: string;
  review?: string | null;
}

type RunPayload = Omit<StoredRun, 'id' | 'repositoryId' | 'number' | 'headSha' | 'state' | 'createdAt'>;

const RUN_COLUMNS = 'id, repository_id, number, head_sha, state, created_at, payload_json';
const PENDING_ARCHIVAL = `chat_id IS NOT NULL AND chat_archived = 0 AND state NOT IN ('queued','reviewing','needs-input')
  AND EXISTS (SELECT 1 FROM review_pulls WHERE repository_id = review_runs.repository_id AND number = review_runs.number AND closed_at IS NOT NULL)`;

function runFromRow(row: RunRow): StoredRun {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    number: row.number,
    headSha: row.head_sha,
    state: row.state,
    createdAt: row.created_at,
    ...JSON.parse(row.payload_json) as RunPayload,
  };
}

function runPayload(run: StoredRun): string {
  const { id: _id, repositoryId: _repositoryId, number: _number, headSha: _headSha, state: _state, createdAt: _createdAt, ...payload } = run;
  return JSON.stringify(payload satisfies RunPayload);
}

// Excludes history-revision trigger writes from the affected run count.
function affectedRuns(database: Database): number {
  return database.query<{ count: number }, []>('SELECT changes() AS count').get()!.count;
}

export class PullRequestReviewStore {
  #database: Database | null = null;
  // Only in-flight reads use this fence; it has no meaning across controller lifetimes.
  readonly #runRevisions = new Map<string, number>();

  constructor(workspaceDir: string) {
    const path = join(workspaceDir, 'pull-request-reviews.sqlite');
    try {
      const database = openPrivateSqliteDatabase(path);
      this.#database = database;
      configureDurableSqlite(database);
      database.transaction(() => {
        database.exec(PULL_REQUEST_REVIEW_SCHEMA.join(';\n'));
        database.query('INSERT OR IGNORE INTO review_meta VALUES (1, 0)').run();
      }).immediate();
      securePrivateSqliteSidecars(path);
    } catch (error) {
      logger.warn('Pull request review storage open failed.', { errorCode: diagnosticErrorCode(error) });
      this.close();
      throw reviewStorageUnavailable();
    }
  }

  get available(): boolean {
    return this.#database !== null;
  }

  close(): void {
    const database = this.#database;
    this.#database = null;
    try { database?.close(); }
    catch { /* A failed connection stays fenced even if close also fails. */ }
  }

  #read<T>(operation: (database: Database) => T): T {
    if (!this.#database) throw reviewStorageUnavailable();
    try { return operation(this.#database); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      logger.warn('Pull request review storage fenced.', { errorCode: diagnosticErrorCode(error) });
      this.close();
      throw reviewStorageUnavailable();
    }
  }

  // Runs one change and advances the revision clients compare snapshots by.
  #write<T>(operation: (database: Database) => T): T {
    return this.#read((database) => database.transaction(() => {
      const changes = database.query<{ count: number }, []>('SELECT total_changes() AS count');
      const before = changes.get()!.count;
      const result = operation(database);
      if (changes.get()!.count !== before) database.query('UPDATE review_meta SET revision = revision + 1 WHERE singleton = 1').run();
      return result;
    }).immediate());
  }

  revision(): number {
    return this.#read((database) => database.query<{ revision: number }, []>(
      'SELECT revision FROM review_meta WHERE singleton = 1',
    ).get()?.revision ?? 0);
  }

  listRepositories(): PullRequestReviewRepository[] {
    return this.#read((database) => database.query<{ payload_json: string; scan_json: string }, []>(
      'SELECT payload_json, scan_json FROM review_repositories ORDER BY rowid',
    ).all().map((row) => ({ ...JSON.parse(row.payload_json) as StoredRepository, scan: JSON.parse(row.scan_json) as PullRequestReviewScan })));
  }

  getRepository(id: string): PullRequestReviewRepository | null {
    return this.#read((database) => {
      const row = database.query<{ payload_json: string; scan_json: string }, [string]>(
        'SELECT payload_json, scan_json FROM review_repositories WHERE id = ?',
      ).get(id);
      return row ? { ...JSON.parse(row.payload_json) as StoredRepository, scan: JSON.parse(row.scan_json) as PullRequestReviewScan } : null;
    });
  }

  insertRepository(repository: StoredRepository, scan: PullRequestReviewScan, pulls: PullRequestSummary[]): void {
    this.#write((database) => {
      const count = database.query<{ count: number }, []>('SELECT count(*) AS count FROM review_repositories').get()!.count;
      if (count >= PULL_REQUEST_REVIEW_MAX_REPOSITORIES) throw reviewConflict(`At most ${PULL_REQUEST_REVIEW_MAX_REPOSITORIES} repositories can be connected.`);
      const identity = this.#assertRepositoryIdentity(database, repository);
      database.query('INSERT INTO review_repositories (id, payload_json, scan_json, pulls_json, executor_id, repository_host, repository_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(repository.id, JSON.stringify(repository), JSON.stringify(scan), JSON.stringify(pulls), effectiveExecutorId(repository.target.executorId), identity.host, identity.nameWithOwner);
    });
  }

  updateRepository(repository: StoredRepository): boolean {
    return this.#write((database) => {
      const identity = this.#assertRepositoryIdentity(database, repository);
      return database.query('UPDATE review_repositories SET payload_json = ?, executor_id = ?, repository_host = ?, repository_name = ? WHERE id = ?')
        .run(JSON.stringify(repository), effectiveExecutorId(repository.target.executorId), identity.host, identity.nameWithOwner, repository.id).changes > 0;
    });
  }

  // Checks identity under the same immediate transaction as the write; the index also enforces it.
  #assertRepositoryIdentity(database: Database, repository: StoredRepository): GhRepositoryIdentity {
    const identity = ghRepositoryIdentity(repository);
    if (!identity) throw reviewConflict('The repository has an invalid GitHub identity.');
    const existing = database.query<{ id: string }, [string, string, string, string]>(
      'SELECT id FROM review_repositories WHERE executor_id = ? AND repository_host = ? AND repository_name = ? AND id != ?',
    ).get(effectiveExecutorId(repository.target.executorId), identity.host, identity.nameWithOwner, repository.id);
    if (existing) throw reviewConflict(`${repository.nameWithOwner} is already connected on this executor.`);
    return identity;
  }

  deleteRepository(id: string): boolean {
    const deleted = this.#write((database) => database.query('DELETE FROM review_repositories WHERE id = ?').run(id).changes > 0);
    if (deleted) this.#runRevisions.delete(id);
    return deleted;
  }

  // Records a scan result. A failed scan passes no pulls and keeps the last list.
  recordScan(id: string, scan: PullRequestReviewScan, pulls?: PullRequestSummary[]): boolean {
    return this.#write((database) => {
      if (pulls === undefined) {
        return database.query('UPDATE review_repositories SET scan_json = ? WHERE id = ?').run(JSON.stringify(scan), id).changes > 0;
      }
      const changed = database.query('UPDATE review_repositories SET scan_json = ?, pulls_json = ? WHERE id = ?')
        .run(JSON.stringify(scan), JSON.stringify(pulls), id).changes > 0;
      if (changed) {
        // Retention starts at observed closure; a reopened pull request starts afresh.
        database.query(`UPDATE review_pulls SET closed_at = ? WHERE repository_id = ? AND closed_at IS NULL
          AND number NOT IN (SELECT json_extract(value, '$.number') FROM json_each(?))`)
          .run(scan.scannedAt, id, JSON.stringify(pulls));
        database.query(`UPDATE review_pulls SET closed_at = NULL WHERE repository_id = ? AND closed_at IS NOT NULL
          AND number IN (SELECT json_extract(value, '$.number') FROM json_each(?))`)
          .run(id, JSON.stringify(pulls));
      }
      return changed;
    });
  }

  pulls(repositoryId: string): PullRequestSummary[] {
    return this.#read((database) => {
      const row = database.query<{ pulls_json: string }, [string]>('SELECT pulls_json FROM review_repositories WHERE id = ?').get(repositoryId);
      return row ? JSON.parse(row.pulls_json) as PullRequestSummary[] : [];
    });
  }

  insertRun(run: StoredRun): void {
    this.#write((database) => {
      database.query('INSERT OR IGNORE INTO review_pulls (repository_id, number) VALUES (?, ?)').run(run.repositoryId, run.number);
      database.query(`INSERT INTO review_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.repositoryId, run.number, run.headSha, run.state, run.createdAt, runPayload(run));
    });
    this.#touchRuns(run.repositoryId);
  }

  // Applies a change to a run that still exists; the review text changes only when given.
  updateRun(id: string, change: (run: StoredRun) => StoredRun | null, review?: string | null): StoredRun | null {
    const updated = this.#write((database) => {
      const row = database.query<RunRow, [string]>(`SELECT ${RUN_COLUMNS} FROM review_runs WHERE id = ?`).get(id);
      if (!row) return null;
      const next = change(runFromRow(row));
      if (!next) return null;
      if (review === undefined) {
        database.query('UPDATE review_runs SET state = ?, payload_json = ? WHERE id = ?').run(next.state, runPayload(next), id);
      } else {
        database.query('UPDATE review_runs SET state = ?, payload_json = ?, review = ? WHERE id = ?').run(next.state, runPayload(next), review, id);
      }
      return next;
    });
    if (updated) this.#touchRuns(updated.repositoryId);
    return updated;
  }

  getRun(id: string): StoredRunDetail | null {
    return this.#read((database) => {
      const row = database.query<RunRow, [string]>(`SELECT ${RUN_COLUMNS}, review FROM review_runs WHERE id = ?`).get(id);
      return row ? { ...runFromRow(row), review: row.review ?? null } : null;
    });
  }

  runsForPull(repositoryId: string, number: number, cursor: ReviewRunCursor | null = null): StoredRunPage {
    return this.#read((database) => runPage(database.query<RunRow & { sequence: number }, [string, number, string, number, number]>(
      `SELECT ${RUN_COLUMNS}, rowid AS sequence FROM review_runs WHERE repository_id = ? AND number = ?
        AND (created_at, rowid) < (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(repositoryId, number, cursor?.createdAt ?? '\uffff', cursor?.sequence ?? Number.MAX_SAFE_INTEGER, PULL_REQUEST_REVIEW_RUN_PAGE_SIZE + 1)));
  }

  pullRunsRevision(repositoryId: string, number: number): number {
    return this.#read((database) => database.query<{ revision: number }, [string, number]>(
      'SELECT revision FROM review_pulls WHERE repository_id = ? AND number = ?',
    ).get(repositoryId, number)?.revision ?? 0);
  }

  recoveryRuns(cursor: ReviewRunCursor | null = null): StoredRunPage {
    return this.#read((database) => runPage(database.query<RunRow & { sequence: number }, [string, number, number]>(
      `SELECT ${RUN_COLUMNS}, rowid AS sequence FROM review_runs WHERE ${PENDING_REVIEW_POST_RECOVERY}
        AND (created_at, rowid) < (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(cursor?.createdAt ?? '\uffff', cursor?.sequence ?? Number.MAX_SAFE_INTEGER, PULL_REQUEST_REVIEW_RUN_PAGE_SIZE + 1)));
  }

  runsRevision(repositoryId: string): number {
    return this.#runRevisions.get(repositoryId) ?? 0;
  }

  #touchRuns(repositoryId: string): void {
    this.#runRevisions.set(repositoryId, this.runsRevision(repositoryId) + 1);
  }

  latestRunsForOpenPulls(repositoryId: string): StoredRun[] {
    return this.#read((database) => database.query<RunRow, [string, string]>(
      `SELECT ${RUN_COLUMNS} FROM review_runs WHERE rowid IN (
        SELECT (SELECT rowid FROM review_runs WHERE repository_id = ? AND number = json_extract(pull.value, '$.number')
          ORDER BY created_at DESC, rowid DESC LIMIT 1)
        FROM json_each((SELECT pulls_json FROM review_repositories WHERE id = ?)) AS pull
      )`,
    ).all(repositoryId, repositoryId).map(runFromRow));
  }

  hasActiveRun(repositoryId: string, number: number): boolean {
    return this.#read((database) => database.query<{ found: number }, [string, number]>(
      `SELECT 1 AS found FROM review_runs WHERE repository_id = ? AND number = ?
        AND state IN ('queued','reviewing','needs-input') LIMIT 1`,
    ).get(repositoryId, number) !== null);
  }

  hasUnknownPost(repositoryId: string): boolean {
    return this.#read((database) => database.query<{ found: number }, [string]>(
      `SELECT 1 AS found FROM review_runs WHERE repository_id = ? AND json_extract(payload_json, '$.post.status') = 'unknown' LIMIT 1`,
    ).get(repositoryId) !== null);
  }

  markChatRemoved(chatId: string): boolean {
    const repositories = this.#write((database) => {
      const affected = database.query<{ repository_id: string }, [string]>(
        'SELECT DISTINCT repository_id FROM review_runs WHERE chat_id = ?',
      ).all(chatId);
      database.query(`UPDATE review_runs SET payload_json = json_set(payload_json, '$.chatId', NULL, '$.chatArchived', json('true'))
        WHERE chat_id = ?`).run(chatId);
      return affected;
    });
    for (const { repository_id } of repositories) this.#touchRuns(repository_id);
    return repositories.length > 0;
  }

  selectionHistory(repositoryId: string, number: number, head: string): ReviewSelectionHistory {
    return this.#read((database) => {
      const atHead = `SELECT rowid FROM review_runs WHERE repository_id = ? AND number = ? AND head_sha = ?
        UNION SELECT rowid FROM review_runs WHERE repository_id = ? AND number = ? AND reviewed_sha = ?`;
      const counts = database.query<{ stopped: number; attempts: number }, [string, number, string, string, number, string]>(
        `SELECT coalesce(max(state = 'stopped'), 0) AS stopped,
          coalesce(sum(trigger = 'auto' AND json_extract(payload_json, '$.startedAt') IS NOT NULL), 0) AS attempts
          FROM review_runs WHERE rowid IN (${atHead})`,
      ).get(repositoryId, number, head, repositoryId, number, head)!;
      const completed = database.query<{ found: number }, [string, number, string]>(
        `SELECT 1 AS found FROM review_runs WHERE repository_id = ? AND number = ? AND reviewed_sha = ? AND state = 'completed' LIMIT 1`,
      ).get(repositoryId, number, head) !== null;
      return { active: this.hasActiveRun(repositoryId, number), completed, stopped: counts.stopped > 0, attempts: counts.attempts };
    });
  }

  automaticRunsSince(repositoryId: string, since: string): number {
    return this.#read((database) => database.query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM review_runs WHERE repository_id = ? AND trigger = 'auto' AND json_extract(payload_json, '$.startedAt') > ?`,
    ).get(repositoryId, since)!.count);
  }

  queuedAutomaticRunCount(repositoryId: string): number {
    return this.#read((database) => database.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM review_runs WHERE repository_id = ? AND trigger = 'auto' AND state = 'queued'",
    ).get(repositoryId)!.count);
  }

  markOutdated(repositoryId: string, number: number, head: string): number {
    const count = this.#write((database) => {
      database.query(`UPDATE review_runs SET state = 'outdated',
        payload_json = json_set(payload_json, '$.message', 'The pull request has new commits.') WHERE rowid IN (
          SELECT rowid FROM review_runs WHERE repository_id = ? AND number = ? AND state = 'completed'
            AND reviewed_sha != ? LIMIT ?
        )`).run(repositoryId, number, head, REVIEW_HISTORY_BATCH_SIZE);
      return affectedRuns(database);
    });
    if (count) this.#touchRuns(repositoryId);
    return count;
  }

  recentRuns(limit: number): StoredRun[] {
    return this.#read((database) => {
      // Unresolved posts stay reachable after closure and newer reviews, without reading full history.
      const recovery = database.query<RunRow, [number]>(
        `SELECT ${RUN_COLUMNS} FROM review_runs WHERE ${PENDING_REVIEW_POST_RECOVERY} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).all(limit);
      const recent = database.query<RunRow, [number]>(
        `SELECT ${RUN_COLUMNS} FROM review_runs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ).all(limit);
      return [...new Map([...recovery, ...recent].map(row => [row.id, row])).values()].slice(0, limit).map(runFromRow);
    });
  }

  activeRuns(): StoredRun[] {
    return this.#read((database) => database.query<RunRow, []>(
      `SELECT ${RUN_COLUMNS} FROM review_runs WHERE state IN ('queued','reviewing','needs-input') ORDER BY created_at, rowid`,
    ).all().map(runFromRow));
  }

  interruptQueuedAutomaticRuns(repositoryId: string, now: string): number {
    const count = this.#write((database) => {
      database.query(`UPDATE review_runs SET state = 'interrupted',
        payload_json = json_set(payload_json, '$.finishedAt', ?, '$.message', 'Repository settings changed before the automatic review started.')
        WHERE repository_id = ? AND trigger = 'auto' AND state = 'queued'`).run(now, repositoryId);
      return affectedRuns(database);
    });
    if (count) this.#touchRuns(repositoryId);
    return count;
  }

  // Running work does not survive a restart, so every unfinished run ends here.
  interruptActiveRuns(now: string): number {
    const active = this.activeRuns();
    for (const run of active) {
      this.updateRun(run.id, (current) => isActivePullRequestReviewRun(current.state)
        ? { ...current, state: 'interrupted', finishedAt: now, message: 'The controller restarted during this review.' }
        : null);
    }
    return active.length;
  }

  closedPulls(repositoryId: string, afterNumber: number): number[] {
    return this.#read((database) => database.query<{ number: number }, [string, number, number]>(
      `SELECT number FROM review_pulls WHERE repository_id = ? AND closed_at IS NOT NULL AND number > ? ORDER BY number LIMIT ?`,
    ).all(repositoryId, afterNumber, REVIEW_HISTORY_BATCH_SIZE).map((row) => row.number));
  }

  runsToArchive(repositoryId: string, number: number, afterSequence: number): (StoredRun & { sequence: number })[] {
    return this.#read((database) => database.query<RunRow & { sequence: number }, [string, number, number, number]>(
      `SELECT ${RUN_COLUMNS}, rowid AS sequence FROM review_runs WHERE repository_id = ? AND number = ? AND rowid > ?
        AND ${PENDING_ARCHIVAL}
        ORDER BY rowid LIMIT ?`,
    ).all(repositoryId, number, afterSequence, REVIEW_HISTORY_BATCH_SIZE).map((row) => ({ ...runFromRow(row), sequence: row.sequence })));
  }

  isRunPendingArchival(id: string, chatId: string): boolean {
    return this.#read((database) => database.query<{ found: number }, [string, string]>(
      `SELECT 1 AS found FROM review_runs WHERE id = ? AND chat_id = ? AND ${PENDING_ARCHIVAL}`,
    ).get(id, chatId) !== null);
  }

  // Preserves active work, archival retries, and unresolved posts within one bounded batch.
  pruneClosedRuns(repositoryId: string, before: string): number {
    const count = this.#write((database) => {
      database.query(`DELETE FROM review_runs WHERE rowid IN (
        SELECT run.rowid FROM review_pulls AS pull INDEXED BY review_pulls_closed
        CROSS JOIN review_runs AS run INDEXED BY review_runs_prunable
        WHERE pull.repository_id = ? AND pull.closed_at < ? AND run.repository_id = pull.repository_id AND run.number = pull.number
          AND run.state NOT IN ('queued','reviewing','needs-input') AND (run.chat_id IS NULL OR run.chat_archived = 1)
          AND NOT ${PENDING_REVIEW_POST_RECOVERY} LIMIT ?
      )`).run(repositoryId, before, REVIEW_HISTORY_BATCH_SIZE);
      return affectedRuns(database);
    });
    if (count) this.#touchRuns(repositoryId);
    return count;
  }

  pruneClosedPulls(repositoryId: string, before: string): number {
    return this.#write((database) => database.query(`DELETE FROM review_pulls WHERE rowid IN (
      SELECT rowid FROM review_pulls WHERE repository_id = ? AND closed_at < ?
        AND NOT EXISTS (SELECT 1 FROM review_runs WHERE repository_id = review_pulls.repository_id AND number = review_pulls.number) LIMIT ?
    )`).run(repositoryId, before, REVIEW_HISTORY_BATCH_SIZE).changes);
  }
}
