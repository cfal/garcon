import { AgentCallError, type ExecutionGhService } from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
import { GitServiceError } from '../../../common/git-error.js';
import { GH_COMMENT_BODY_MAX_LENGTH, type GhActorIdentity, type GhRepositoryIdentity, type PullRequestMarkedComment } from '../../../common/gh.js';
import { ghRepositoryIdentity, sameGhRepository } from '../../../common/gh-identity.js';
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

// Request, path, and admission rejections occur before the GitHub mutation starts.
const POST_REJECTION_CODES: readonly GitServiceError['code'][] = [
  'GH_MUTATION_REJECTED', 'GIT_INVALID_INPUT', 'GIT_NOT_REPO', 'GIT_OUTSIDE_BASE', 'GIT_SERVICE_BUSY',
];

function postingPullKey(repository: GhRepositoryIdentity, number: number): string {
  return `${repository.host}/${repository.nameWithOwner}#${number}`;
}

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

  abandon(runId: string): void {
    const run = this.deps.store.getRun(runId);
    if (!run || run.post.status !== 'unknown') throw reviewConflict('Only an unresolved post can be abandoned.');
    const repository = this.deps.store.getRepository(run.repositoryId);
    const identity = repository && ghRepositoryIdentity(repository);
    if (identity && this.#postingPulls.has(postingPullKey(identity, run.number))) throw reviewConflict('The review is still being posted. Wait for it to finish before abandoning it.');
    this.#record(runId, {
      ...run.post, status: 'abandoned', abandonedAt: new Date(this.deps.now()).toISOString(),
      message: 'Post recovery was abandoned. The comment may already exist on GitHub. This review cannot be posted again.',
    });
  }

  async post(runId: string): Promise<void> {
    const { store } = this.deps;
    const run = store.getRun(runId);
    if (run?.post.status === 'abandoned') throw reviewConflict('This post was abandoned and cannot be posted again.');
    if (!run || !run.review || !run.reviewedSha
      || run.state !== 'completed' && run.post.status !== 'unknown' && run.post.status !== 'posted') {
      throw reviewConflict('Only a finished review of the current head can be posted.');
    }
    const repository = store.getRepository(run.repositoryId);
    if (!repository) throw reviewConflict('The repository is no longer connected.');
    const identity = ghRepositoryIdentity(repository);
    if (!identity) throw reviewConflict('The connected repository has an invalid GitHub identity. Reconnect it before posting.');
    const pullKey = postingPullKey(identity, run.number);
    if (this.#postingPulls.has(pullKey)) throw reviewConflict('A review of this pull request is already being posted.');
    const body = pullRequestReviewCommentBody(run.review, repository.nameWithOwner, run.number, run.reviewedSha);
    if (body.length > GH_COMMENT_BODY_MAX_LENGTH && run.post.status !== 'unknown' && run.post.status !== 'posted') {
      this.#record(runId, { status: 'too-long', message: 'The review is longer than a GitHub comment allows.' });
      return;
    }
    this.#postingPulls.set(pullKey, run.repositoryId);
    try {
      await this.#post(run, identity, effectiveExecutorId(repository.target.executorId), repository.target.projectPath, body);
    } finally {
      this.#postingPulls.delete(pullKey);
    }
  }

  async #post(run: StoredRun, repository: GhRepositoryIdentity, executorId: string, projectPath: string, body: string): Promise<void> {
    const reviewedSha = run.reviewedSha!;
    const { nameWithOwner } = repository;
    let creating = false;
    try {
      const gh = await this.deps.executors.requireExecutor(executorId).getGhService();
      const target = await gh.getPullRequestReviewTarget({
        projectPath, repository, number: run.number, marker: pullRequestReviewMarkerPrefix(nameWithOwner, run.number),
      });
      if (!sameGhRepository(target.repository, repository)) throw reviewConflict('The GitHub repository has changed. Reconnect the intended repository before posting.');
      const actor = run.post.actor ?? target.viewer;
      const marker = `<!-- ${pullRequestReviewMarkerPrefix(nameWithOwner, run.number)}${reviewedSha} -->`;
      const ownComments = target.markedComments.filter(comment => comment.author?.id === actor.id);
      const existingIndex = ownComments.findIndex((comment) => comment.marker.toLowerCase() === marker);
      const existing = ownComments[existingIndex];
      if (!existing && run.post.status === 'unknown'
        && target.markedComments.some(comment => comment.marker.toLowerCase() === marker)) {
        this.#record(run.id, { ...run.post, message: `A matching comment has another author. Verify the original ${actor.login} posting attempt on GitHub before continuing.` });
        return;
      }
      // Recovery checks the marker even after a push or closure; it never creates another posted comment.
      if (existing || run.post.status === 'posted') {
        if (!existing) {
          this.#record(run.id, { ...run.post, message: 'The posted comment could not be found. Older comments were left visible.' });
          return;
        }
        this.#record(run.id, {
          actor,
          status: 'posted', commentUrl: existing?.url || run.post.commentUrl,
          postedAt: run.post.postedAt ?? new Date(this.deps.now()).toISOString(), message: null,
        });
        const earlier = ownComments.slice(0, existingIndex);
        if (target.viewer.id !== actor.id && earlier.some(comment => !comment.isMinimized)) {
          this.#record(run.id, { ...this.deps.store.getRun(run.id)!.post, message: `The review was posted. Switch GitHub back to ${actor.login} to hide older comments.` });
          return;
        }
        await this.#minimizeEarlier(run.id, earlier, gh, projectPath, repository, actor);
        return;
      }
      if (target.viewer.id !== actor.id) {
        this.#record(run.id, { ...run.post, message: `Switch GitHub back to ${actor.login} to reconcile the original posting attempt.` });
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
      // An interruption after durable admission retains the identity needed for reconciliation.
      this.#record(run.id, { status: 'unknown', actor, message: 'GitHub has not confirmed the comment yet.' });
      creating = true;
      const posted = await gh.createPullRequestComment({ projectPath, repository, actor, number: run.number, body, expected: { state: 'open', headRefOid: reviewedSha } });
      this.#record(run.id, { status: 'posted', actor, commentUrl: posted.url || null, postedAt: new Date(this.deps.now()).toISOString(), message: null });
      await this.#minimizeEarlier(run.id, ownComments, gh, projectPath, repository, actor);
    } catch (error) {
      const savedPost = this.deps.store.getRun(run.id)?.post ?? run.post;
      if (error instanceof GitServiceError && error.code === 'GH_STALE_PULL_REQUEST') {
        this.#record(run.id, { status: 'stale', message: error.message }, 'outdated');
        return;
      }
      if (savedPost.status === 'posted') {
        this.#record(run.id, { ...savedPost, message: 'The review was posted, but older comments could not be hidden. Retry cleanup.' });
        return;
      }
      const rejected = creating && (error instanceof GitServiceError && POST_REJECTION_CODES.includes(error.code)
        || error instanceof AgentCallError && error.outcome !== 'unknown');
      const unknown = !rejected && (savedPost.status === 'unknown'
        || error instanceof GitServiceError && error.code === 'GIT_MUTATION_OUTCOME_UNKNOWN');
      this.#record(run.id, unknown
        ? { status: 'unknown', message: 'GitHub did not confirm the comment. Post again to check for it before a new one is sent.' }
        : { status: 'failed', message: errorMessage(error, 'The review could not be posted.') });
    }
  }

  async #minimizeEarlier(
    runId: string, comments: PullRequestMarkedComment[],
    gh: ExecutionGhService, projectPath: string, repository: GhRepositoryIdentity, actor: GhActorIdentity,
  ): Promise<void> {
    let failed = false;
    for (const previous of comments) {
      if (previous.isMinimized || previous.author?.id !== actor.id) continue;
      try {
        const result = await gh.minimizePullRequestComment({ projectPath, repository, actor, commentId: previous.id });
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
      post: { actor: current.post.actor, commentUrl: null, postedAt: null, message: null, ...post },
    }));
    if (updated) this.deps.changed();
  }
}
