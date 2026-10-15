import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { PullRequestSummary } from '../../../common/gh.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import {
  isActivePullRequestReviewRun,
  PULL_REQUEST_REVIEW_MAX_REPOSITORIES,
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
import { PULL_REQUEST_REVIEW_SCHEMA } from './schema.js';

const logger = createLogger('pull-request-review-store');

export type StoredRepository = Omit<PullRequestReviewRepository, 'scan'>;

// A review run as stored. Projection to the browser contract adds chat availability.
export interface StoredRun extends Omit<PullRequestReviewRun, 'chatAvailable'> {
  turnId: string | null;
  // Set once the review chat was archived because its pull request left the open list.
  chatArchived: boolean;
}

export type StoredRunDetail = StoredRun & { review: string | null };

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

export class PullRequestReviewStore {
  #database: Database | null = null;

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
      const result = operation(database);
      database.query('UPDATE review_meta SET revision = revision + 1 WHERE singleton = 1').run();
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
      this.#assertRepositoryIdentity(database, repository);
      database.query('INSERT INTO review_repositories (id, payload_json, scan_json, pulls_json, executor_id, repository_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(repository.id, JSON.stringify(repository), JSON.stringify(scan), JSON.stringify(pulls), effectiveExecutorId(repository.target.executorId), repository.nameWithOwner.toLowerCase());
    });
  }

  updateRepository(repository: StoredRepository): boolean {
    return this.#write((database) => {
      this.#assertRepositoryIdentity(database, repository);
      return database.query('UPDATE review_repositories SET payload_json = ?, executor_id = ?, repository_name = ? WHERE id = ?')
        .run(JSON.stringify(repository), effectiveExecutorId(repository.target.executorId), repository.nameWithOwner.toLowerCase(), repository.id).changes > 0;
    });
  }

  // Checks identity under the same immediate transaction as the write; the index also enforces it.
  #assertRepositoryIdentity(database: Database, repository: StoredRepository): void {
    const existing = database.query<{ id: string }, [string, string, string]>(
      'SELECT id FROM review_repositories WHERE executor_id = ? AND repository_name = ? AND id != ?',
    ).get(effectiveExecutorId(repository.target.executorId), repository.nameWithOwner.toLowerCase(), repository.id);
    if (existing) throw reviewConflict(`${repository.nameWithOwner} is already connected on this executor.`);
  }

  deleteRepository(id: string): boolean {
    return this.#write((database) => database.query('DELETE FROM review_repositories WHERE id = ?').run(id).changes > 0);
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
        database.query(`UPDATE review_runs SET closed_at = CASE
          WHEN number IN (SELECT json_extract(value, '$.number') FROM json_each(
            (SELECT pulls_json FROM review_repositories WHERE id = ?)
          )) THEN NULL ELSE coalesce(closed_at, ?) END WHERE repository_id = ?`)
          .run(id, scan.scannedAt, id);
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
      database.query(`INSERT INTO review_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.repositoryId, run.number, run.headSha, run.state, run.createdAt, runPayload(run));
    });
  }

  // Applies a change to a run that still exists; the review text changes only when given.
  updateRun(id: string, change: (run: StoredRun) => StoredRun | null, review?: string | null): StoredRun | null {
    return this.#write((database) => {
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
  }

  getRun(id: string): StoredRunDetail | null {
    return this.#read((database) => {
      const row = database.query<RunRow, [string]>(`SELECT ${RUN_COLUMNS}, review FROM review_runs WHERE id = ?`).get(id);
      return row ? { ...runFromRow(row), review: row.review ?? null } : null;
    });
  }

  runsForPull(repositoryId: string, number: number, limit = 50): StoredRunDetail[] {
    return this.#read((database) => database.query<RunRow, [string, number, number]>(
      `SELECT ${RUN_COLUMNS}, review FROM review_runs WHERE repository_id = ? AND number = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(repositoryId, number, limit).map((row) => ({ ...runFromRow(row), review: row.review ?? null })));
  }

  runsForRepository(repositoryId: string): StoredRun[] {
    return this.#read((database) => database.query<RunRow, [string]>(
      `SELECT ${RUN_COLUMNS} FROM review_runs WHERE repository_id = ? ORDER BY created_at DESC, rowid DESC`,
    ).all(repositoryId).map(runFromRow));
  }

  recentRuns(limit: number): StoredRun[] {
    return this.#read((database) => database.query<RunRow, [number]>(
      `SELECT ${RUN_COLUMNS} FROM review_runs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(limit).map(runFromRow));
  }

  activeRuns(): StoredRun[] {
    return this.#read((database) => database.query<RunRow, []>(
      `SELECT ${RUN_COLUMNS} FROM review_runs WHERE state IN ('queued','reviewing','needs-input') ORDER BY created_at, rowid`,
    ).all().map(runFromRow));
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

  // Preserves active work and archival retries even after closure retention expires.
  pruneClosedRuns(repositoryId: string, before: string): void {
    this.#write((database) => database.query(`DELETE FROM review_runs
      WHERE repository_id = ? AND closed_at < ?
        AND state NOT IN ('queued', 'reviewing', 'needs-input')
        AND (json_extract(payload_json, '$.chatId') IS NULL OR json_extract(payload_json, '$.chatArchived') = 1)`)
      .run(repositoryId, before));
  }
}
