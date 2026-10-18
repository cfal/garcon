import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { PullRequestListResult, PullRequestSummary } from '../../../common/gh.js';
import { ghRepositoryIdentity, sameGhRepository } from '../../../common/gh-identity.js';
import {
  PULL_REQUEST_REVIEW_RECENT_RUN_LIMIT,
  normalizePullRequestReviewRepositoryInput,
  type PullRequestAutoReviewStatus,
  type PullRequestReviewInboxEntry,
  type PullRequestReviewRepository,
  type PullRequestReviewRepositoryInput,
  type PullRequestReviewRun,
  type PullRequestReviewRunDetail,
  type PullRequestReviewsSnapshot,
} from '../../../common/pull-request-reviews.js';
import { hasLeadingSlashCommand } from '../../../common/scheduled-prompts.js';
import { GH_DETAIL_TIMEOUT_MS } from '../../../common/git-execution.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { RetainProviderReferences } from '../api-providers/reference-writes.js';
import type { RetainExecutorReferences } from '../executors/reference-writes.js';
import { reviewConflict, reviewInvalid, reviewNotFound } from './errors.js';
import type { PullRequestReviewStore, StoredRepository, StoredRun, StoredRunDetail } from './store.js';

export interface GhServiceSource {
  // Throws when the executor is unavailable; a reconnecting executor's calls wait within their deadline.
  requireExecutor(executorId: string): { getGhService(): Promise<ExecutionGhService> };
}

export interface PullRequestReviewRepositoriesDeps {
  store: PullRequestReviewStore;
  executors: GhServiceSource;
  agents: Pick<AgentRegistryServiceContract, 'hasAgent' | 'assertExecutorReady' | 'assertExecutionModeSelectionSupported' | 'executionPolicy'>;
  chats: { hasChat(chatId: string): boolean };
  retainExecutorReferences?: RetainExecutorReferences;
  retainProviderReferences?: RetainProviderReferences;
  autoReviewStatus(repositoryId: string, number: number): PullRequestAutoReviewStatus | null;
  isPostingRepository(repositoryId: string): boolean;
  repositoryUpdated(repositoryId: string): void;
  changed(): void;
  now(): number;
}

// Owns connected repositories and projects stored state into the browser contract.
export class PullRequestReviewRepositories {
  constructor(private readonly deps: PullRequestReviewRepositoriesDeps) {}

  snapshot(): PullRequestReviewsSnapshot {
    const { store } = this.deps;
    const repositories = store.listRepositories();
    const inbox: PullRequestReviewInboxEntry[] = [];
    for (const repository of repositories) {
      const latest = new Map<number, StoredRun>();
      for (const run of store.latestRunsForOpenPulls(repository.id)) latest.set(run.number, run);
      for (const pull of store.pulls(repository.id)) {
        const run = latest.get(pull.number);
        inbox.push({
          repositoryId: repository.id,
          pull,
          historyRevision: store.pullRunsRevision(repository.id, pull.number),
          latestRun: run ? this.projectRun(run) : null,
          autoReview: this.deps.autoReviewStatus(repository.id, pull.number)
            ?? (repository.settings.autoReview ? { kind: 'eligible' } : { kind: 'off' }),
        });
      }
    }
    return {
      revision: store.revision(),
      repositories,
      inbox,
      recentRuns: store.recentRuns(PULL_REQUEST_REVIEW_RECENT_RUN_LIMIT).map((run) => this.projectRun(run)),
    };
  }

  projectRun(run: StoredRun): PullRequestReviewRun {
    return {
      id: run.id,
      repositoryId: run.repositoryId,
      number: run.number,
      title: run.title,
      headSha: run.headSha,
      reviewedSha: run.reviewedSha,
      state: run.state,
      trigger: run.trigger,
      message: run.message,
      chatId: run.chatId,
      chatAvailable: run.chatId !== null && this.deps.chats.hasChat(run.chatId),
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      post: run.post,
    };
  }

  projectRunDetail(run: StoredRunDetail): PullRequestReviewRunDetail {
    return { ...this.projectRun(run), review: run.review };
  }

  require(id: string): PullRequestReviewRepository {
    const repository = this.deps.store.getRepository(id);
    if (!repository) throw reviewNotFound('Repository');
    return repository;
  }

  requirePull(repositoryId: string, number: number): PullRequestSummary {
    const pull = this.deps.store.pulls(repositoryId).find((entry) => entry.number === number);
    if (!pull) throw reviewNotFound('Pull request');
    return pull;
  }

  // Resolves the folder's GitHub repository with its executor's `gh` before saving it.
  async connect(value: unknown): Promise<PullRequestReviewRepository> {
    const input = this.#validate(value);
    const list = await this.#readRepository(input);
    if (!list.repo) throw reviewInvalid('This folder has no GitHub repository.');
    const repo = list.repo;
    const now = new Date(this.deps.now()).toISOString();
    const repository: StoredRepository = {
      id: crypto.randomUUID(),
      target: input.target,
      settings: input.settings,
      nameWithOwner: repo.nameWithOwner,
      url: repo.url,
      viewerLogin: list.viewerLogin,
      createdAt: now,
      updatedAt: now,
    };
    this.#publish(repository, null, () => this.deps.store.insertRepository(
      repository,
      { status: 'ok', scannedAt: now, message: null },
      list.pulls,
    ));
    return this.require(repository.id);
  }

  async update(id: string, value: unknown): Promise<PullRequestReviewRepository> {
    const current = this.require(id);
    const normalized = normalizePullRequestReviewRepositoryInput(value);
    if (!normalized) throw reviewInvalid('Repository settings are invalid.');
    const preservedTarget = isDeepStrictEqual(normalized.target, current.target);
    const input = preservedTarget ? normalized : this.#validate(value);
    if (preservedTarget && input.settings.prompt !== current.settings.prompt) this.#validatePrompt(input);
    const moved = effectiveExecutorId(input.target.executorId) !== effectiveExecutorId(current.target.executorId)
      || input.target.projectPath !== current.target.projectPath;
    let viewerLogin = current.viewerLogin;
    if (moved) {
      this.#assertNoUnsettledPost(id);
      // A new folder must still be a checkout of the same repository.
      const list = await this.#readRepository(input);
      const expected = ghRepositoryIdentity(current);
      const actual = list.repo && ghRepositoryIdentity(list.repo);
      if (!expected || !actual || !sameGhRepository(expected, actual)) {
        throw reviewInvalid(`This folder is not a checkout of ${current.nameWithOwner}.`);
      }
      viewerLogin = list.viewerLogin;
    }
    const latest = this.require(id);
    if (latest.updatedAt !== current.updatedAt) throw reviewConflict('The repository changed while it was being saved. Try again.');
    if (moved) this.#assertNoUnsettledPost(id);
    const { scan: _scan, ...stored } = latest;
    const next: StoredRepository = {
      ...stored,
      target: input.target,
      settings: input.settings,
      viewerLogin,
      updatedAt: new Date(Math.max(this.deps.now(), Date.parse(latest.updatedAt) + 1)).toISOString(),
    };
    this.#publish(next, latest, () => {
      if (!this.deps.store.updateRepository(next)) throw reviewNotFound('Repository');
    });
    this.deps.repositoryUpdated(id);
    return this.require(id);
  }

  #assertNoUnsettledPost(id: string): void {
    if (this.deps.isPostingRepository(id) || this.deps.store.hasUnknownPost(id)) {
      throw reviewConflict('A review is being posted or has an unconfirmed post. Reconcile it before changing the repository target or disconnecting it.');
    }
  }

  remove(id: string): void {
    const current = this.require(id);
    this.#assertNoUnsettledPost(id);
    if (this.deps.store.activeRuns().some((run) => run.repositoryId === id && run.state !== 'queued')) {
      throw reviewConflict('Stop the running review before disconnecting this repository.');
    }
    this.#publish(null, current, () => this.deps.store.deleteRepository(id));
  }

  // Saved provider selections block provider deletion. A store that cannot be read keeps that protection.
  referencesApiProvider(id: string): boolean {
    if (!this.deps.store.available) return true;
    return this.deps.store.listRepositories().some((repository) => repository.target.apiProviderId === id);
  }

  #validate(value: unknown): PullRequestReviewRepositoryInput {
    const input = normalizePullRequestReviewRepositoryInput(value);
    if (!input) throw reviewInvalid('Repository settings are invalid.');
    const { target } = input;
    this.deps.agents.assertExecutorReady(target.executorId);
    if (!this.deps.agents.hasAgent(target.agentId, target.executorId)) {
      throw reviewInvalid(`Unsupported agent: ${target.agentId}`);
    }
    this.deps.agents.assertExecutionModeSelectionSupported(target.agentId, {
      executorId: target.executorId,
      permissionMode: target.permissionMode,
      thinkingMode: target.thinkingMode,
    });
    this.#validatePrompt(input);
    return input;
  }

  #validatePrompt(input: PullRequestReviewRepositoryInput): void {
    if (hasLeadingSlashCommand(input.settings.prompt.trim())
      && this.deps.agents.executionPolicy(input.target.agentId, input.target.executorId) === 'conversation') {
      throw reviewInvalid('The review prompt cannot start with a slash command.');
    }
  }

  async #readRepository(input: PullRequestReviewRepositoryInput): Promise<PullRequestListResult> {
    const gh = await this.deps.executors.requireExecutor(effectiveExecutorId(input.target.executorId)).getGhService();
    return gh.listPullRequests({ projectPath: input.target.projectPath }, { timeoutMs: GH_DETAIL_TIMEOUT_MS });
  }

  // Holds executor and provider reference protection across the write that changes them.
  #publish(next: StoredRepository | null, current: PullRequestReviewRepository | null, write: () => void): void {
    const releaseExecutors = this.deps.retainExecutorReferences?.(
      next ? [effectiveExecutorId(next.target.executorId)] : [],
      current ? [effectiveExecutorId(current.target.executorId)] : [],
    );
    try {
      const releaseProviders = this.deps.retainProviderReferences?.(
        next ? [next.target.apiProviderId] : [],
        current ? [current.target.apiProviderId] : [],
      );
      try { write(); }
      finally { releaseProviders?.(); }
    } finally {
      releaseExecutors?.();
    }
    this.deps.changed();
  }
}
