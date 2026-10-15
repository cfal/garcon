import { effectiveExecutorId } from '../../../common/executors.js';
import { GitServiceError } from '../../../common/git-error.js';
import { GH_COMMENT_BODY_MAX_LENGTH } from '../../../common/gh.js';
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
  readonly #posting = new Set<string>();

  constructor(private readonly deps: PullRequestReviewPosterDeps) {}

  async post(runId: string): Promise<void> {
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (!run || run.state !== 'completed' || !run.review || !run.reviewedSha) {
      throw reviewConflict('Only a finished review of the current head can be posted.');
    }
    if (run.post.status === 'posted') throw reviewConflict('This review is already posted.');
    const repository = store.getRepository(run.repositoryId);
    if (!repository) throw reviewConflict('The repository is no longer connected.');
    if (repository.settings.posting === 'off') throw reviewConflict('Posting is off for this repository.');
    if (this.#posting.has(runId)) throw reviewConflict('This review is already being posted.');
    const body = pullRequestReviewCommentBody(run.review, repository.nameWithOwner, run.number, run.reviewedSha);
    if (body.length > GH_COMMENT_BODY_MAX_LENGTH) {
      this.#record(runId, { status: 'too-long', message: 'The review is longer than a GitHub comment allows.' });
      return;
    }
    this.#posting.add(runId);
    try {
      await this.#post(run, repository.nameWithOwner, effectiveExecutorId(repository.target.executorId), repository.target.projectPath, body);
    } finally {
      this.#posting.delete(runId);
    }
  }

  async #post(run: StoredRun, nameWithOwner: string, executorId: string, projectPath: string, body: string): Promise<void> {
    const reviewedSha = run.reviewedSha!;
    try {
      const gh = await this.deps.executors.requireExecutor(executorId).getGhService();
      const target = await gh.getPullRequestReviewTarget({
        projectPath, number: run.number, marker: pullRequestReviewMarkerPrefix(nameWithOwner, run.number),
      });
      if (target.state !== 'open') {
        this.#record(run.id, { status: 'stale', message: 'The pull request is no longer open.' });
        return;
      }
      if (target.headRefOid !== reviewedSha) {
        this.#record(run.id, { status: 'stale', message: 'The pull request has new commits, so this review was not posted.' }, 'outdated');
        return;
      }
      // A post whose reply was lost is found again by its marker rather than sent twice.
      const existing = target.markedComments.find((comment) => comment.marker.includes(reviewedSha));
      const posted = existing ?? await gh.createPullRequestComment({ projectPath, number: run.number, body });
      this.#record(run.id, { status: 'posted', commentUrl: posted.url || null, postedAt: new Date(this.deps.now()).toISOString(), message: null });
      for (const previous of target.markedComments) {
        if (previous.isMinimized || previous.marker.includes(reviewedSha)) continue;
        await gh.minimizePullRequestComment({ projectPath, commentId: previous.id })
          .catch((error) => logger.warn('Could not minimize an outdated review comment.', { error: errorMessage(error) }));
      }
    } catch (error) {
      const unknown = error instanceof GitServiceError && error.code === 'GIT_MUTATION_OUTCOME_UNKNOWN';
      this.#record(run.id, unknown
        ? { status: 'unknown', message: 'GitHub did not confirm the comment. Post again to check for it before a new one is sent.' }
        : { status: 'failed', message: errorMessage(error, 'The review could not be posted.') });
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
