import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
import { GitServiceError } from '../../../common/git-error.js';
import { GH_COMMENT_BODY_MAX_LENGTH, type PullRequestMarkedComment } from '../../../common/gh.js';
import {
  pullRequestReviewCommentBody,
  pullRequestReviewMarkerPrefix,
  type PullRequestReviewPost,
} from '../../../common/pull-request-reviews.js';
import { errorMessage } from '../../common/errors.js';
import { createLogger } from '../../common/log.js';
import { reviewConflict } from './errors.js';
import type { GhServiceSource } from './service.js';
import type { PullRequestReviewStore, StoredRun } from './store.js';

const logger = createLogger('pull-request-review-poster');

export interface PullRequestReviewPosterDeps {
  store: PullRequestReviewStore;
  executors: GhServiceSource;
  changed(): void;
  now(): number;
}

// Posts a finished review as one pull request comment under the executor's `gh` login.
export class PullRequestReviewPoster {
  readonly #postingPulls = new Map<string, string>();

  constructor(private readonly deps: PullRequestReviewPosterDeps) {}

  isPostingRepository(repositoryId: string): boolean {
    return [...this.#postingPulls.values()].includes(repositoryId);
  }

  async post(runId: string): Promise<void> {
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (!run || !run.review || !run.reviewedSha
      || run.state !== 'completed' && run.post.status !== 'unknown' && run.post.status !== 'posted') {
      throw reviewConflict('Only a finished review of the current head can be posted.');
    }
    const repository = store.getRepository(run.repositoryId);
    if (!repository) throw reviewConflict('The repository is no longer connected.');
    const pullKey = `${run.repositoryId}:${run.number}`;
    if (this.#postingPulls.has(pullKey)) throw reviewConflict('A review of this pull request is already being posted.');
    const body = pullRequestReviewCommentBody(run.review, repository.nameWithOwner, run.number, run.reviewedSha);
    if (body.length > GH_COMMENT_BODY_MAX_LENGTH && run.post.status !== 'unknown' && run.post.status !== 'posted') {
      this.#record(runId, { status: 'too-long', message: 'The review is longer than a GitHub comment allows.' });
      return;
    }
    this.#postingPulls.set(pullKey, run.repositoryId);
    try {
      await this.#post(run, repository.nameWithOwner, effectiveExecutorId(repository.target.executorId), repository.target.projectPath, body);
    } finally {
      this.#postingPulls.delete(pullKey);
    }
  }

  async #post(run: StoredRun, nameWithOwner: string, executorId: string, projectPath: string, body: string): Promise<void> {
    const reviewedSha = run.reviewedSha!;
    try {
      const gh = await this.deps.executors.requireExecutor(executorId).getGhService();
      const target = await gh.getPullRequestReviewTarget({
        projectPath, number: run.number, marker: pullRequestReviewMarkerPrefix(nameWithOwner, run.number),
      });
      const marker = `<!-- ${pullRequestReviewMarkerPrefix(nameWithOwner, run.number)}${reviewedSha} -->`;
      const existingIndex = target.markedComments.findIndex((comment) => comment.marker.toLowerCase() === marker);
      const existing = target.markedComments[existingIndex];
      // Recovery checks the marker even after a push or closure; it never creates another posted comment.
      if (existing || run.post.status === 'posted') {
        if (!existing) {
          this.#record(run.id, { ...run.post, message: 'The posted comment could not be found. Older comments were left visible.' });
          return;
        }
        this.#record(run.id, {
          status: 'posted', commentUrl: existing?.url || run.post.commentUrl,
          postedAt: run.post.postedAt ?? new Date(this.deps.now()).toISOString(), message: null,
        });
        await this.#minimizeEarlier(run.id, target.markedComments.slice(0, existingIndex), gh, projectPath);
        return;
      }
      const current = this.deps.store.getRun(run.id);
      if (current?.state !== 'completed' || current.reviewedSha !== reviewedSha) {
        this.#record(run.id, { status: 'stale', message: 'This review is no longer current, so it was not posted.' });
        return;
      }
      if (target.state !== 'open') {
        this.#record(run.id, { status: 'stale', message: 'The pull request is no longer open.' });
        return;
      }
      if (target.headRefOid !== reviewedSha) {
        this.#record(run.id, { status: 'stale', message: 'The pull request has new commits, so this review was not posted.' }, 'outdated');
        return;
      }
      const posted = await gh.createPullRequestComment({ projectPath, number: run.number, body });
      this.#record(run.id, { status: 'posted', commentUrl: posted.url || null, postedAt: new Date(this.deps.now()).toISOString(), message: null });
      await this.#minimizeEarlier(run.id, target.markedComments, gh, projectPath);
    } catch (error) {
      if (run.post.status === 'posted') {
        this.#record(run.id, { ...run.post, message: 'The review was posted, but older comments could not be hidden. Retry cleanup.' });
        return;
      }
      const unknown = run.post.status === 'unknown'
        || error instanceof GitServiceError && error.code === 'GIT_MUTATION_OUTCOME_UNKNOWN';
      this.#record(run.id, unknown
        ? { status: 'unknown', message: 'GitHub did not confirm the comment. Post again to check for it before a new one is sent.' }
        : { status: 'failed', message: errorMessage(error, 'The review could not be posted.') });
    }
  }

  async #minimizeEarlier(
    runId: string, comments: PullRequestMarkedComment[],
    gh: ExecutionGhService, projectPath: string,
  ): Promise<void> {
    let failed = false;
    for (const previous of comments) {
      if (previous.isMinimized) continue;
      try {
        const result = await gh.minimizePullRequestComment({ projectPath, commentId: previous.id });
        if (!result.minimized) failed = true;
      } catch (error) {
        failed = true;
        logger.warn('Could not minimize an outdated review comment.', { error: errorMessage(error) });
      }
    }
    if (failed) {
      const run = this.deps.store.getRun(runId);
      if (run) this.#record(runId, { ...run.post, message: 'The review was posted, but older comments could not be hidden. Retry cleanup.' });
    }
  }

  #record(runId: string, post: Partial<PullRequestReviewPost> & Pick<PullRequestReviewPost, 'status'>, state?: 'outdated'): void {
    const updated = this.deps.store.updateRun(runId, (current) => ({
      ...current,
      ...(state ? { state } : {}),
      post: { commentUrl: null, postedAt: null, message: null, ...post },
    }));
    if (updated) this.deps.changed();
  }
}
