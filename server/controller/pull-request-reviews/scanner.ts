import { AgentCallError } from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
import { GH_DETAIL_TIMEOUT_MS } from '../../../common/git-execution.js';
import {
  PULL_REQUEST_REVIEW_SCAN_INTERVAL_MINUTES,
  isActivePullRequestReviewRun,
  type PullRequestAutoReviewStatus,
  type PullRequestReviewRepository,
  type PullRequestReviewScan,
} from '../../../common/pull-request-reviews.js';
import { isDomainError } from '../../common/domain-error.js';
import { errorMessage } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import { decideAutoReview } from './selection.js';
import type { PullRequestReviewRunner } from './runner.js';
import type { GhServiceSource } from './service.js';
import type { PullRequestReviewStore, StoredRun } from './store.js';

const logger = createLogger('pull-request-review-scanner');

const TICK_MS = 30_000;
const SCAN_INTERVAL_MS = PULL_REQUEST_REVIEW_SCAN_INTERVAL_MINUTES * 60_000;
const DAY_MS = 24 * 60 * 60_000;
// Runs of pull requests that have been closed this long are dropped.
const CLOSED_RUN_RETENTION_MS = 30 * DAY_MS;

export interface PullRequestReviewScannerDeps {
  store: PullRequestReviewStore;
  executors: GhServiceSource;
  runner: Pick<PullRequestReviewRunner, 'enqueue' | 'pump'>;
  archiveChat(chatId: string): Promise<void>;
  changed(): void;
  now(): number;
}

// Polls each connected repository's open pull requests and queues the automatic reviews they need.
export class PullRequestReviewScanner {
  #timer: ReturnType<typeof setInterval> | null = null;
  #scanning = false;
  #rescan = false;
  readonly #forced = new Set<string>();
  readonly #lastAttempt = new Map<string, number>();
  // When each repository's pull request was first seen at its current head; restarts reset it.
  readonly #headObserved = new Map<string, { sha: string; at: number }>();
  readonly #status = new Map<string, Map<number, PullRequestAutoReviewStatus>>();
  readonly #archiving = new Set<string>();

  constructor(private readonly deps: PullRequestReviewScannerDeps) {}

  start(): void {
    this.#timer = setInterval(() => void this.scanDue(), TICK_MS);
    this.#timer.unref?.();
    void this.scanDue();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  autoReviewStatus(repositoryId: string, number: number): PullRequestAutoReviewStatus | null {
    return this.#status.get(repositoryId)?.get(number) ?? null;
  }

  // Scans soon, ahead of the interval; with no repository, every repository is scanned.
  requestScan(repositoryId?: string): void {
    for (const repository of repositoryId ? [repositoryId] : this.deps.store.listRepositories().map((entry) => entry.id)) {
      this.#forced.add(repository);
    }
    void this.scanDue();
  }

  forget(repositoryId: string): void {
    this.#status.delete(repositoryId);
    this.#lastAttempt.delete(repositoryId);
    this.#forced.delete(repositoryId);
    for (const key of this.#headObserved.keys()) if (key.startsWith(`${repositoryId}:`)) this.#headObserved.delete(key);
  }

  async scanDue(): Promise<void> {
    if (!this.#timer) return;
    if (this.#scanning) {
      this.#rescan = true;
      return;
    }
    this.#scanning = true;
    try {
      do {
        this.#rescan = false;
        if (!this.deps.store.available) return;
        const now = this.deps.now();
        for (const repository of this.deps.store.listRepositories()) {
          const forced = this.#forced.delete(repository.id);
          if (!forced && now - (this.#lastAttempt.get(repository.id) ?? -Infinity) < SCAN_INTERVAL_MS) continue;
          await this.#scan(repository);
        }
      } while (this.#rescan);
    } catch (error) {
      logger.warn('Pull request review scan stopped.', { error: errorMessage(error) });
    } finally {
      this.#scanning = false;
    }
  }

  async #scan(repository: PullRequestReviewRepository): Promise<void> {
    this.#lastAttempt.set(repository.id, this.deps.now());
    let scan: PullRequestReviewScan;
    try {
      const gh = await this.deps.executors.requireExecutor(effectiveExecutorId(repository.target.executorId)).getGhService();
      const list = await gh.listPullRequests({ projectPath: repository.target.projectPath }, { timeoutMs: GH_DETAIL_TIMEOUT_MS });
      // A repository edited or removed during the read is scanned again under its new settings.
      const current = this.deps.store.getRepository(repository.id);
      if (!current || current.updatedAt !== repository.updatedAt) return;
      if (list.repo?.nameWithOwner !== repository.nameWithOwner) {
        scan = { ...repository.scan, status: 'failed', message: `The folder is no longer a checkout of ${repository.nameWithOwner}.` };
        if (this.deps.store.recordScan(repository.id, scan)) this.deps.changed();
        return;
      }
      scan = { status: 'ok', scannedAt: new Date(this.deps.now()).toISOString(), message: null };
      if (!this.deps.store.recordScan(repository.id, scan, list.pulls)) return;
    } catch (error) {
      const unavailable = isDomainError(error) && error.code === 'EXECUTOR_UNAVAILABLE' || error instanceof AgentCallError;
      // An unreachable executor keeps the last list rather than reporting no pull requests.
      scan = {
        ...repository.scan,
        status: unavailable ? 'executor-unavailable' : 'failed',
        message: unavailable ? 'The executor is offline. Reviews resume when it reconnects.' : errorMessage(error, 'The pull requests could not be read.'),
      };
      if (this.deps.store.recordScan(repository.id, scan)) this.deps.changed();
      return;
    }
    this.#evaluate(this.deps.store.getRepository(repository.id) ?? repository);
    this.deps.changed();
    this.deps.runner.pump();
  }

  #evaluate(repository: PullRequestReviewRepository): void {
    const { store } = this.deps;
    const now = this.deps.now();
    const pulls = store.pulls(repository.id);
    const runs = store.runsForRepository(repository.id);
    const byNumber = new Map<number, StoredRun[]>();
    for (const run of runs) byNumber.set(run.number, [...byNumber.get(run.number) ?? [], run]);
    const statuses = new Map<number, PullRequestAutoReviewStatus>();
    let startedInLastDay = runs.filter((run) => run.trigger === 'auto' && now - Date.parse(run.createdAt) < DAY_MS).length;
    const open = new Set(pulls.map((pull) => pull.number));
    for (const pull of pulls) {
      const key = `${repository.id}:${pull.number}`;
      const observed = this.#headObserved.get(key);
      if (observed?.sha !== pull.headRefOid) this.#headObserved.set(key, { sha: pull.headRefOid, at: now });
      const pullRuns = byNumber.get(pull.number) ?? [];
      this.#markOutdated(pullRuns, pull.headRefOid);
      if (!repository.settings.autoReview) {
        statuses.set(pull.number, { kind: 'off' });
        continue;
      }
      const decision = decideAutoReview({
        settings: repository.settings,
        pull,
        runs: pullRuns,
        headObservedAt: this.#headObserved.get(key)!.at,
        startedInLastDay,
        now,
      });
      statuses.set(pull.number, decision.kind === 'skip' ? { kind: 'skipped', reason: decision.reason } : { kind: 'eligible' });
      if (decision.kind !== 'review') continue;
      this.deps.runner.enqueue(repository.id, pull, 'auto');
      startedInLastDay += 1;
    }
    for (const key of this.#headObserved.keys()) {
      const [repositoryId, number] = key.split(':');
      if (repositoryId === repository.id && !open.has(Number(number))) this.#headObserved.delete(key);
    }
    this.#status.set(repository.id, statuses);
    this.#archiveClosed(runs, open);
    store.pruneClosedRuns(repository.id, [...open], new Date(now - CLOSED_RUN_RETENTION_MS).toISOString());
  }

  // A finished review of an older head no longer describes the pull request.
  #markOutdated(runs: readonly StoredRun[], head: string): void {
    for (const run of runs) {
      if (run.state !== 'completed' || run.reviewedSha === head) continue;
      this.deps.store.updateRun(run.id, (current) => current.state === 'completed' && current.reviewedSha !== head
        ? { ...current, state: 'outdated', message: 'The pull request has new commits.' }
        : null);
    }
  }

  // Review chats of merged or closed pull requests leave the active sidebar.
  #archiveClosed(runs: readonly StoredRun[], open: ReadonlySet<number>): void {
    for (const run of runs) {
      if (open.has(run.number) || !run.chatId || run.chatArchived || this.#archiving.has(run.id) || isActivePullRequestReviewRun(run.state)) continue;
      const chatId = run.chatId;
      this.#archiving.add(run.id);
      void this.deps.archiveChat(chatId)
        .then(() => {
          if (!this.deps.store.available) return;
          if (this.deps.store.updateRun(run.id, (current) => ({ ...current, chatArchived: true }))) this.deps.changed();
        })
        .catch((error) => logger.warn('Could not archive a review chat.', { error: errorMessage(error) }))
        .finally(() => this.#archiving.delete(run.id));
    }
  }
}
