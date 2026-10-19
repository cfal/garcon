import type { PullRequestReviewRun, PullRequestReviewRunDetail, PullRequestReviewRunsResponse, PullRequestReviewRecoveryResponse, PullRequestReviewsSnapshot, PullRequestReviewRepository } from '../../../common/pull-request-reviews.js';
import { createLogger } from '../../common/log.js';
import type { TranscriptCommitEvent } from '../ledger/service.js';
import { reviewConflict, reviewNotFound, reviewStorageUnavailable } from './errors.js';
import { PullRequestReviewPoster } from './poster.js';
import { PullRequestReviewRunner, type PullRequestReviewRunnerDeps } from './runner.js';
import { PullRequestReviewScanner } from './scanner.js';
import { PullRequestReviewRepositories, type PullRequestReviewRepositoriesDeps } from './service.js';
import { PullRequestReviewStore, type ReviewRunCursor } from './store.js';

export interface PullRequestReviewsDeps
  extends Omit<PullRequestReviewRepositoriesDeps, 'store' | 'autoReviewStatus' | 'isPostingRepository' | 'repositoryUpdated' | 'changed' | 'now'>,
    Omit<PullRequestReviewRunnerDeps, 'store' | 'poster' | 'changed' | 'now'> {
  archiveChat(chatId: string): Promise<void>;
  onInvalidated(revision: number): void;
  now?: () => number;
}

// The controller's pull request review domain: connected repositories, scanning, review chats, and posting.
export class PullRequestReviews {
  readonly #repositories: PullRequestReviewRepositories;
  readonly #scanner: PullRequestReviewScanner;
  readonly #runner: PullRequestReviewRunner;
  readonly #poster: PullRequestReviewPoster;
  #invalidationScheduled = false;

  constructor(private readonly store: PullRequestReviewStore, private readonly deps: PullRequestReviewsDeps) {
    const now = deps.now ?? Date.now;
    const changed = () => this.#scheduleInvalidation();
    // Running work does not survive a restart; nothing is replayed.
    store.interruptActiveRuns(new Date(now()).toISOString());
    this.#poster = new PullRequestReviewPoster({ store, executors: deps.executors, changed, now });
    this.#runner = new PullRequestReviewRunner({ ...deps, store, poster: this.#poster, changed, now });
    this.#scanner = new PullRequestReviewScanner({
      store, executors: deps.executors, runner: this.#runner, archiveChat: deps.archiveChat, changed, now,
    });
    this.#repositories = new PullRequestReviewRepositories({
      ...deps,
      store,
      autoReviewStatus: (repositoryId, number) => this.#scanner.autoReviewStatus(repositoryId, number),
      isPostingRepository: (repositoryId) => this.#poster.isPostingRepository(repositoryId),
      repositoryUpdated: (repositoryId) => this.#runner.cancelQueuedAutomaticRuns(repositoryId),
      changed,
      now,
    });
  }

  start(): void {
    this.#runner.start();
    this.#scanner.start();
  }

  stop(): void {
    this.#scanner.stop();
    this.#runner.stop();
  }

  close(): void {
    this.store.close();
  }

  snapshot(): PullRequestReviewsSnapshot {
    return this.#repositories.snapshot();
  }

  referencesApiProvider(id: string): boolean {
    return this.#repositories.referencesApiProvider(id);
  }

  handleTranscriptCommit(event: TranscriptCommitEvent): void {
    this.#runner.handleTranscriptCommit(event);
  }

  handleChatRemoved(chatId: string): void {
    if (!this.store.available) return;
    if (this.store.markChatRemoved(chatId)) this.#scheduleInvalidation();
  }

  async connect(body: unknown): Promise<PullRequestReviewRepository> {
    const repository = await this.#repositories.connect(body);
    this.#scanner.requestScan(repository.id);
    return repository;
  }

  async update(id: string, body: unknown): Promise<PullRequestReviewRepository> {
    const repository = await this.#repositories.update(id, body);
    this.#scanner.requestScan(id);
    return repository;
  }

  remove(id: string): void {
    this.#repositories.remove(id);
    this.#scanner.forget(id);
  }

  scan(repositoryId?: string): void {
    if (repositoryId) this.#repositories.require(repositoryId);
    this.#scanner.requestScan(repositoryId);
  }

  runs(repositoryId: string, number: number, cursor: ReviewRunCursor | null = null): PullRequestReviewRunsResponse {
    this.#repositories.require(repositoryId);
    const page = this.store.runsForPull(repositoryId, number, cursor);
    return { ...page, runs: page.runs.map((run) => this.#repositories.projectRun(run)), revision: this.store.pullRunsRevision(repositoryId, number) };
  }

  runDetail(runId: string): PullRequestReviewRunDetail {
    const run = this.store.getRun(runId);
    if (!run) throw reviewNotFound('Review');
    return this.#repositories.projectRunDetail(run);
  }

  recoveryRuns(cursor: ReviewRunCursor | null = null): PullRequestReviewRecoveryResponse {
    const page = this.store.recoveryRuns(cursor);
    return { ...page, runs: page.runs.map((run) => this.#repositories.projectRun(run)) };
  }

  // Reviews the pull request's current head now, regardless of filters and the automatic setting.
  review(repositoryId: string, number: number): PullRequestReviewRun {
    this.#repositories.require(repositoryId);
    const pull = this.#repositories.requirePull(repositoryId, number);
    const run = this.#runner.enqueue(repositoryId, pull, 'manual');
    this.#runner.pump();
    return this.#repositories.projectRun(this.store.getRun(run.id) ?? run);
  }

  async stopRun(runId: string): Promise<void> {
    await this.#runner.stopRun(runId);
  }

  async postRun(runId: string): Promise<PullRequestReviewRun> {
    await this.#poster.post(runId);
    const run = this.store.getRun(runId);
    if (!run) throw reviewConflict('The review no longer exists.');
    return this.#repositories.projectRun(run);
  }

  abandonPost(runId: string): PullRequestReviewRun {
    this.#poster.abandon(runId);
    return this.#repositories.projectRun(this.store.getRun(runId)!);
  }

  // Coalesces the changes of one turn of the event loop into one browser invalidation.
  #scheduleInvalidation(): void {
    if (this.#invalidationScheduled) return;
    this.#invalidationScheduled = true;
    queueMicrotask(() => {
      this.#invalidationScheduled = false;
      if (!this.store.available) return;
      try { this.deps.onInvalidated(this.store.revision()); }
      catch (error) { createLogger('pull-request-reviews').warn('Review invalidation failed.', { error }); }
    });
  }
}

export interface PullRequestReviewsRuntime {
  // Throws while storage is unavailable.
  readonly service: PullRequestReviews;
  referencesApiProvider(id: string): boolean;
  handleChatRemoved(chatId: string): void;
  start(): void;
  stop(): void;
  close(): void;
}

export function initializePullRequestReviews(workspaceDir: string, deps: PullRequestReviewsDeps): PullRequestReviewsRuntime {
  let service: PullRequestReviews | null = null;
  try {
    service = new PullRequestReviews(new PullRequestReviewStore(workspaceDir), deps);
  } catch {
    createLogger('pull-request-reviews').warn('Pull request review storage could not open; reviews remain unavailable until restart.');
  }
  return {
    get service() {
      if (!service) throw reviewStorageUnavailable();
      return service;
    },
    // Unreadable storage may still hold saved selections, so it keeps protecting them.
    referencesApiProvider: (id) => service?.referencesApiProvider(id) ?? true,
    handleChatRemoved(chatId) { service?.handleChatRemoved(chatId); },
    start() { service?.start(); },
    stop() { service?.stop(); },
    close() { service?.close(); },
  };
}
