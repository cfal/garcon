import { AgentCallError } from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { PullRequestFingerprintBatch } from '../../../common/gh.js';
import { ghRepositoryIdentity, sameGhRepository } from '../../../common/gh-identity.js';
import { GitServiceError } from '../../../common/git-error.js';
import { GH_DETAIL_TIMEOUT_MS } from '../../../common/git-execution.js';
import {
  PULL_REQUEST_REVIEW_SCAN_INTERVAL_MINUTES,
  type PullRequestAutoReviewStatus,
  type PullRequestReviewRepository,
  type PullRequestReviewScan,
} from '../../../common/pull-request-reviews.js';
import { isDomainError } from '../../common/domain-error.js';
import { errorMessage } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import { fingerprintBatches, planFingerprintRefresh } from './fingerprints.js';
import { decideAutoReview } from './selection.js';
import type { PullRequestReviewRunner } from './runner.js';
import type { GhServiceSource } from './service.js';
import { REVIEW_HISTORY_BATCH_SIZE, type PullRequestReviewStore } from './store.js';

const logger = createLogger('pull-request-review-scanner');

const TICK_MS = 30_000;
const SCAN_INTERVAL_MS = PULL_REQUEST_REVIEW_SCAN_INTERVAL_MINUTES * 60_000;
// A fingerprint batch takes one slot however many repositories it covers.
const MAX_CONCURRENT_SCANS = 4;
// Fields the fingerprint omits, such as labels, team review requests, and the
// checkout's repository, are reread at least this often.
const FULL_READ_INTERVAL_MS = 30 * 60_000;
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

// Polls each connected repository's open pull requests and queues the automatic
// reviews they need. Between full reads, repositories are checked with batched
// fingerprints; see `fingerprints.ts`.
export class PullRequestReviewScanner {
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #scanning = new Set<string>();
  #runningScans = 0;
  // When each repository's last successful full read began; restarts read every repository in full.
  readonly #fullReadAt = new Map<string, number>();
  // Repositories whose last check failed only because GitHub was rate limiting the account.
  readonly #rateLimited = new Set<string>();
  readonly #forced = new Set<string>();
  readonly #lastAttempt = new Map<string, number>();
  // When each repository's pull request was first seen at its current head; restarts reset it.
  readonly #headObserved = new Map<string, { sha: string; at: number }>();
  readonly #status = new Map<string, Map<number, PullRequestAutoReviewStatus>>();
  readonly #maintaining = new Set<string>();
  readonly #maintenanceRequested = new Map<string, string>();

  constructor(private readonly deps: PullRequestReviewScannerDeps) {}

  start(): void {
    this.#timer = setInterval(() => void this.scanDue(), TICK_MS);
    this.#timer.unref?.();
    void this.scanDue();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#maintenanceRequested.clear();
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
    this.#fullReadAt.delete(repositoryId);
    this.#rateLimited.delete(repositoryId);
    this.#forced.delete(repositoryId);
    for (const key of this.#headObserved.keys()) if (key.startsWith(`${repositoryId}:`)) this.#headObserved.delete(key);
  }

  async scanDue(): Promise<void> {
    if (!this.#timer || !this.deps.store.available) return;
    try {
      const now = this.deps.now();
      const repositories = this.deps.store.listRepositories()
        .sort((a, b) => Number(this.#forced.has(b.id)) - Number(this.#forced.has(a.id)));
      const fullReads: PullRequestReviewRepository[] = [];
      const fingerprinted: { repository: PullRequestReviewRepository; executorId: string; identity: NonNullable<ReturnType<typeof ghRepositoryIdentity>> }[] = [];
      for (const repository of repositories) {
        if (this.#scanning.has(repository.id)) continue;
        const forced = this.#forced.has(repository.id);
        if (!forced && now - (this.#lastAttempt.get(repository.id) ?? -Infinity) < SCAN_INTERVAL_MS) continue;
        const identity = ghRepositoryIdentity(repository);
        if (forced || !identity || this.#needsFullRead(repository, now)) fullReads.push(repository);
        else fingerprinted.push({ repository, executorId: effectiveExecutorId(repository.target.executorId), identity });
      }
      const jobs = [
        ...fullReads.map((repository) => ({ repositories: [repository], run: () => this.#scan(repository) })),
        ...fingerprintBatches(fingerprinted).map((batch) => ({
          repositories: batch.map((entry) => entry.repository),
          run: () => this.#sweep(batch[0].executorId, batch.map((entry) => entry.repository)),
        })),
      ];
      for (const job of jobs) {
        if (this.#runningScans >= MAX_CONCURRENT_SCANS) return;
        this.#runningScans += 1;
        for (const repository of job.repositories) {
          this.#forced.delete(repository.id);
          this.#scanning.add(repository.id);
        }
        void job.run()
          .catch((error) => logger.warn('Pull request review scan stopped.', { error: errorMessage(error) }))
          .finally(() => {
            this.#runningScans -= 1;
            for (const repository of job.repositories) this.#scanning.delete(repository.id);
            void this.scanDue();
          });
      }
    } catch (error) {
      logger.warn('Pull request review scan stopped.', { error: errorMessage(error) });
    }
  }

  // A repository whose last scan failed, or whose full read is due, is read in
  // full. A rate-limited check stays a fingerprint check, so backing off never
  // turns into more reads.
  #needsFullRead(repository: PullRequestReviewRepository, now: number): boolean {
    if (this.#rateLimited.has(repository.id)) return false;
    if (repository.scan.status !== 'ok') return true;
    return now - (this.#fullReadAt.get(repository.id) ?? -Infinity) >= FULL_READ_INTERVAL_MS;
  }

  async #scan(repository: PullRequestReviewRepository): Promise<void> {
    const startedAt = this.deps.now();
    this.#lastAttempt.set(repository.id, startedAt);
    const before = this.deps.store.runsRevision(repository.id);
    let scan: PullRequestReviewScan;
    try {
      const expected = ghRepositoryIdentity(repository);
      if (!expected) throw new Error('The connected GitHub repository identity is invalid.');
      const gh = await this.deps.executors.requireExecutor(effectiveExecutorId(repository.target.executorId)).getGhService();
      if (!this.#timer || !this.deps.store.available
        || this.deps.store.getRepository(repository.id)?.updatedAt !== repository.updatedAt) return;
      const list = await gh.listPullRequests({ projectPath: repository.target.projectPath, repository: expected }, { timeoutMs: GH_DETAIL_TIMEOUT_MS });
      // A repository edited or removed during the read is scanned again under its new settings.
      if (!this.#timer || !this.deps.store.available) return;
      const current = this.deps.store.getRepository(repository.id);
      if (!current || current.updatedAt !== repository.updatedAt) return;
      // A read begun before a review changed cannot invalidate it or enqueue an older head.
      if (this.deps.store.runsRevision(repository.id) !== before) {
        this.#repeat(repository.id);
        return;
      }
      const actual = list.repo && ghRepositoryIdentity(list.repo);
      if (!list.repo || !actual || !sameGhRepository(expected, actual)) {
        scan = { ...repository.scan, status: 'failed', message: `The folder is no longer a checkout of ${repository.nameWithOwner}.` };
        if (this.deps.store.recordScan(repository.id, scan)) this.deps.changed();
        return;
      }
      if (list.repo.nameWithOwner !== current.nameWithOwner || list.repo.url !== current.url || list.viewerLogin !== current.viewerLogin) {
        const { scan: _scan, ...stored } = current;
        this.deps.store.updateRepository({ ...stored, nameWithOwner: list.repo.nameWithOwner, url: list.repo.url, viewerLogin: list.viewerLogin });
      }
      scan = { status: 'ok', scannedAt: new Date(this.deps.now()).toISOString(), message: null };
      if (!this.deps.store.recordScan(repository.id, scan, list.pulls)) return;
      this.#fullReadAt.set(repository.id, startedAt);
      this.#rateLimited.delete(repository.id);
    } catch (error) {
      if (!this.#timer || !this.deps.store.available
        || this.deps.store.getRepository(repository.id)?.updatedAt !== repository.updatedAt) return;
      if (error instanceof GitServiceError && error.code === 'GH_RATE_LIMITED') this.#rateLimited.add(repository.id);
      else this.#rateLimited.delete(repository.id);
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
    await this.#evaluate(this.deps.store.getRepository(repository.id) ?? repository);
    this.deps.changed();
    this.deps.runner.pump();
  }

  // Checks one executor's repositories on one host with a single fingerprint
  // read. A batch that fails as a whole reads each repository in full, which
  // records its own outcome, except when GitHub is rate limiting the account.
  async #sweep(executorId: string, repositories: PullRequestReviewRepository[]): Promise<void> {
    const { store } = this.deps;
    const startedAt = this.deps.now();
    for (const repository of repositories) this.#lastAttempt.set(repository.id, startedAt);
    const before = repositories.map((repository) => store.runsRevision(repository.id));
    let batch: PullRequestFingerprintBatch;
    try {
      const gh = await this.deps.executors.requireExecutor(executorId).getGhService();
      batch = await gh.getPullRequestFingerprints(
        { repositories: repositories.map((repository) => ghRepositoryIdentity(repository)!) },
        { timeoutMs: GH_DETAIL_TIMEOUT_MS },
      );
      if (batch.repositories.length !== repositories.length) throw new Error('GitHub answered a different number of repositories.');
    } catch (error) {
      if (!this.#timer || !store.available) return;
      if (error instanceof GitServiceError && error.code === 'GH_RATE_LIMITED') {
        this.#recordRateLimited(repositories, errorMessage(error, 'GitHub API rate limit exceeded.'));
        return;
      }
      for (const repository of repositories) this.#repeat(repository.id);
      return;
    }
    for (const [index, repository] of repositories.entries()) {
      await this.#applyFingerprints(repository, before[index], batch.viewerLogin, batch.repositories[index]);
    }
  }

  // A rate-limited batch keeps every list and waits for the next interval rather than reading more.
  #recordRateLimited(repositories: PullRequestReviewRepository[], message: string): void {
    let changed = false;
    for (const repository of repositories) {
      const current = this.deps.store.getRepository(repository.id);
      if (!current || current.updatedAt !== repository.updatedAt) continue;
      this.#rateLimited.add(repository.id);
      changed = this.deps.store.recordScan(repository.id, { ...current.scan, status: 'failed', message }) || changed;
    }
    if (changed) this.deps.changed();
  }

  async #applyFingerprints(
    repository: PullRequestReviewRepository,
    before: number,
    viewerLogin: string,
    fingerprints: PullRequestFingerprintBatch['repositories'][number],
  ): Promise<void> {
    const { store } = this.deps;
    if (!this.#timer || !store.available) return;
    const current = store.getRepository(repository.id);
    // An edited or removed repository is scanned again under its new settings.
    if (!current || current.updatedAt !== repository.updatedAt) return;
    if (store.runsRevision(repository.id) !== before) {
      this.#repeat(repository.id);
      return;
    }
    const plan = planFingerprintRefresh({ ...current, pulls: store.pulls(repository.id) }, viewerLogin, fingerprints);
    if (plan.kind === 'full-read') {
      this.#repeat(repository.id);
      return;
    }
    const scan: PullRequestReviewScan = { status: 'ok', scannedAt: new Date(this.deps.now()).toISOString(), message: null };
    if (!store.recordScan(repository.id, scan, plan.kind === 'apply' ? plan.pulls : undefined)) return;
    const recovered = this.#rateLimited.delete(repository.id);
    if (recovered && this.deps.now() - (this.#fullReadAt.get(repository.id) ?? -Infinity) >= FULL_READ_INTERVAL_MS)
      this.#repeat(repository.id);
    // Debounce and daily limits move with time, so selection runs even when nothing changed.
    await this.#evaluate(store.getRepository(repository.id) ?? current);
    this.deps.changed();
    this.deps.runner.pump();
  }

  #repeat(repositoryId: string): void {
    this.#forced.add(repositoryId);
  }

  async #evaluate(repository: PullRequestReviewRepository): Promise<void> {
    const { store } = this.deps;
    const now = this.deps.now();
    const pulls = store.pulls(repository.id);
    const steps = new EventLoopSteps('pull-request-review-evaluate');
    let revision = store.runsRevision(repository.id);
    const isCurrent = () => this.#timer !== null && store.getRepository(repository.id)?.updatedAt === repository.updatedAt
      && store.runsRevision(repository.id) === revision;
    const statuses = new Map<number, PullRequestAutoReviewStatus>();
    let startedInLastDay = store.automaticRunsSince(repository.id, new Date(now - DAY_MS).toISOString())
      + store.queuedAutomaticRunCount(repository.id);
    const open = new Set(pulls.map((pull) => pull.number));
    for (const pull of pulls) {
      const key = `${repository.id}:${pull.number}`;
      const observed = this.#headObserved.get(key);
      if (observed?.sha !== pull.headRefOid) this.#headObserved.set(key, { sha: pull.headRefOid, at: now });
      let outdated: number;
      do {
        outdated = store.markOutdated(repository.id, pull.number, pull.headRefOid);
        revision = store.runsRevision(repository.id);
        if (steps.due) {
          await steps.next();
          if (!isCurrent()) { this.#repeat(repository.id); return; }
        }
      } while (outdated === REVIEW_HISTORY_BATCH_SIZE);
      if (!repository.settings.autoReview) {
        statuses.set(pull.number, { kind: 'off' });
        continue;
      }
      const decision = decideAutoReview({
        settings: repository.settings,
        pull,
        history: store.selectionHistory(repository.id, pull.number, pull.headRefOid),
        headObservedAt: this.#headObserved.get(key)!.at,
        startedInLastDay,
        now,
      });
      statuses.set(pull.number, decision.kind === 'skip' ? { kind: 'skipped', reason: decision.reason } : { kind: 'eligible' });
      if (decision.kind !== 'review') continue;
      this.deps.runner.enqueue(repository.id, pull, 'auto');
      revision = store.runsRevision(repository.id);
      startedInLastDay += 1;
    }
    for (const key of this.#headObserved.keys()) {
      const [repositoryId, number] = key.split(':');
      if (repositoryId === repository.id && !open.has(Number(number))) this.#headObserved.delete(key);
    }
    this.#status.set(repository.id, statuses);
    this.#requestMaintenance(repository.id, new Date(now - CLOSED_RUN_RETENTION_MS).toISOString());
  }

  #requestMaintenance(repositoryId: string, before: string): void {
    this.#maintenanceRequested.set(repositoryId, before);
    if (this.#maintaining.has(repositoryId)) return;
    this.#maintaining.add(repositoryId);
    void (async () => {
      while (this.#timer && this.#maintenanceRequested.has(repositoryId)) {
        const cutoff = this.#maintenanceRequested.get(repositoryId)!;
        this.#maintenanceRequested.delete(repositoryId);
        await this.#maintainClosed(repositoryId, cutoff);
      }
    })().catch((error) => logger.warn('Review history maintenance failed.', { error: errorMessage(error) }))
      .finally(() => this.#maintaining.delete(repositoryId));
  }

  // Review chats of merged or closed pull requests leave the active sidebar.
  async #maintainClosed(repositoryId: string, before: string): Promise<void> {
    const { store } = this.deps;
    const steps = new EventLoopSteps('pull-request-review-history-maintenance');
    let number = 0;
    while (this.#timer && store.available) {
      const closed = store.closedPulls(repositoryId, number);
      for (const pullNumber of closed) {
        number = pullNumber;
        let sequence = 0;
        while (this.#timer && store.available) {
          const runs = store.runsToArchive(repositoryId, number, sequence);
          for (const run of runs) {
            if (!this.#timer || !store.available) return;
            sequence = run.sequence;
            try {
              // A batch may outlive its pull request's closure or repository connection.
              if (store.isRunPendingArchival(run.id, run.chatId!)) {
                await this.deps.archiveChat(run.chatId!);
                if (!this.#timer || !store.available) return;
                if (store.updateRun(run.id, (current) => ({ ...current, chatArchived: true }))) this.deps.changed();
              }
            } catch (error) {
              logger.warn('Could not archive a review chat.', { error: errorMessage(error) });
            }
            if (steps.due) await steps.next();
          }
          if (runs.length < REVIEW_HISTORY_BATCH_SIZE) break;
        }
        if (steps.due) await steps.next();
      }
      if (closed.length < REVIEW_HISTORY_BATCH_SIZE) break;
    }
    while (this.#timer && store.available) {
      const removed = store.pruneClosedRuns(repositoryId, before);
      if (removed) this.deps.changed();
      if (steps.due) await steps.next();
      if (removed < REVIEW_HISTORY_BATCH_SIZE) break;
    }
    while (this.#timer && store.available) {
      const removed = store.pruneClosedPulls(repositoryId, before);
      if (removed) this.deps.changed();
      if (steps.due) await steps.next();
      if (removed < REVIEW_HISTORY_BATCH_SIZE) break;
    }
  }
}
