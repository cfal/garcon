// Owns one Pull Requests surface: the inbox selection, search, the selected
// pull request's status, diff, and review threads from its repository's
// executor, and that pull request's review runs. The inbox itself comes from
// the shared review store, so it shows the last scan immediately instead of
// waiting on GitHub. Inbox changes refresh only the reads they invalidate; see
// `pull-request-refresh-keys.ts`.

import { ApiError } from '$lib/api/client.js';
import {
	getPullRequestDiff,
	getPullRequestReviewThreads,
	getPullRequestStatus,
	type PullRequestCheck,
	type PullRequestDiff,
	type PullRequestStatus,
	type PullRequestTarget,
	type PullRequestReviewThreads,
} from '$lib/api/pull-requests.js';
import {
	getPullRequestReviewRun,
	getPullRequestReviewRuns,
} from '$lib/api/pull-request-reviews.js';
import * as m from '$lib/paraglide/messages.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { errorMessage } from '$lib/utils/error-message.js';
import { effectiveExecutorId } from '$shared/executors';
import { ghRepositoryIdentity } from '$shared/gh-identity';
import type {
	PullRequestReviewInboxEntry,
	PullRequestReviewRepository,
	PullRequestReviewRun,
	PullRequestReviewRunDetail,
} from '$shared/pull-request-reviews';
import { groupInbox, inboxEntryKey, type PullRequestInboxGroup } from './pull-request-inbox.js';
import { createPullRequestDiffCache, pullRequestDiffKey } from './pull-request-diff-cache.js';
import {
	pullRequestChangesView,
	pullRequestChecksView,
	type PullRequestChanges,
	type PullRequestPartView,
} from './pull-request-detail-view.js';
import { PullRequestReadState, type PullRequestReadOutcome } from './pull-request-read.svelte.js';
import {
	pullRequestDiffCommits,
	pullRequestReviewThreadsKey,
	pullRequestStatusKey,
} from './pull-request-refresh-keys.js';
import type { PullRequestReviewsStore } from './pull-request-reviews-store.svelte.js';

export type PullRequestDetailTab = 'review' | 'changes' | 'checks';

export interface PullRequestsStoreDeps {
	reviews: PullRequestReviewsStore;
	notifyError?: (message: string) => void;
	getStatus?: typeof getPullRequestStatus;
	getDiff?: typeof getPullRequestDiff;
	getReviewThreads?: typeof getPullRequestReviewThreads;
	getRuns?: typeof getPullRequestReviewRuns;
	getRun?: typeof getPullRequestReviewRun;
}

export class PullRequestsStore implements PortableSingletonController {
	readonly reviews: PullRequestReviewsStore;
	readonly status = new PullRequestReadState<PullRequestStatus>(() => m.pull_request_load_failed());
	readonly diff = new PullRequestReadState<PullRequestDiff>(() =>
		m.pull_request_changes_load_failed(),
	);
	readonly reviewThreads = new PullRequestReadState<PullRequestReviewThreads>(() =>
		m.pull_request_review_threads_load_failed(),
	);
	readonly #deps: PullRequestsStoreDeps;
	// Shared by every selection this surface shows; bounded and cleared on dispose.
	readonly #diffCache = createPullRequestDiffCache();
	#visible = false;
	// The selected pull request's repository, executor, and checkout; a change discards every read.
	#selectionScope: string | null = null;
	#runsController: AbortController | null = null;
	#runController: AbortController | null = null;
	#runsVersion: number | null = null;
	#coherentChanges = $state.raw<PullRequestChanges | null>(null);
	// The scan status follows. A failed read keeps its scan, so later scans wait for Retry.
	#statusScan: string | null = null;

	query = $state('');
	repositoryFilter = $state<string | null>(null);
	selectedKey = $state<string | null>(null);
	tab = $state<PullRequestDetailTab>('review');
	runs = $state<PullRequestReviewRun[]>([]);
	nextRunsCursor = $state<string | null>(null);
	isRunsLoading = $state(false);
	isMoreRunsLoading = $state(false);
	runsError = $state<string | null>(null);
	selectedRun = $state<PullRequestReviewRunDetail | null>(null);
	isRunLoading = $state(false);
	runError = $state<string | null>(null);
	// The run shown in the Review tab; null shows the latest.
	selectedRunId = $state<string | null>(null);

	constructor(deps: PullRequestsStoreDeps) {
		this.#deps = deps;
		this.reviews = deps.reviews;
	}

	get groups(): PullRequestInboxGroup[] {
		return groupInbox(this.reviews.inbox, {
			query: this.query,
			repositoryId: this.repositoryFilter,
		});
	}

	get selectedEntry(): PullRequestReviewInboxEntry | null {
		return this.reviews.inbox.find((entry) => inboxEntryKey(entry) === this.selectedKey) ?? null;
	}

	get selectedRepository(): PullRequestReviewRepository | null {
		const entry = this.selectedEntry;
		return entry ? this.reviews.repository(entry.repositoryId) : null;
	}

	get hasSelection(): boolean {
		return this.selectedKey !== null;
	}

	get isRefreshing(): boolean {
		return this.status.isLoading || this.diff.isLoading || this.reviewThreads.isLoading;
	}

	get checksView(): PullRequestPartView<readonly PullRequestCheck[]> {
		return pullRequestChecksView(this.status);
	}

	get changesView(): PullRequestPartView<PullRequestChanges> {
		return pullRequestChangesView(
			this.status,
			this.diff,
			this.reviewThreads,
			this.#coherentChanges,
		);
	}

	get shownRun(): PullRequestReviewRunDetail | null {
		const latest = this.selectedEntry?.latestRun;
		const selected = this.selectedRunId
			? (this.runs.find((run) => run.id === this.selectedRunId) ?? this.selectedRun)
			: null;
		if (
			latest &&
			(this.isRunsLoading || this.runsError !== null) &&
			(!selected || selected.id === latest.id)
		) {
			return {
				...latest,
				review: this.selectedRun?.id === latest.id ? this.selectedRun.review : null,
			};
		}
		const summary = selected ?? this.runs[0] ?? latest;
		if (!summary) return null;
		return {
			...summary,
			review: this.selectedRun?.id === summary.id ? this.selectedRun.review : null,
		};
	}

	// The inbox does not follow the chat's project.
	setProjectState(): void {}

	setPresentationVisible(visible: boolean): void {
		if (visible === this.#visible) return;
		this.#visible = visible;
		if (!visible) return;
		void this.reviews.ensureLoaded();
		this.syncSelection();
	}

	// Asks the server to read every connected repository's pull requests now.
	async scan(): Promise<void> {
		try {
			await this.reviews.scan();
		} catch (error) {
			this.#deps.notifyError?.(errorMessage(error, m.pull_request_review_action_failed()));
		}
	}

	select(entry: PullRequestReviewInboxEntry): void {
		const key = inboxEntryKey(entry);
		if (key === this.selectedKey) return;
		this.clearSelection();
		this.selectedKey = key;
		this.syncSelection();
	}

	clearSelection(): void {
		this.#resetPullRequest();
		this.#runsController?.abort();
		this.#runController?.abort();
		this.#runsController = null;
		this.#runController = null;
		this.#runsVersion = null;
		this.selectedKey = null;
		this.selectedRunId = null;
		this.runs = [];
		this.nextRunsCursor = null;
		this.isMoreRunsLoading = false;
		this.isRunsLoading = false;
		this.runsError = null;
		this.selectedRun = null;
		this.isRunLoading = false;
		this.runError = null;
	}

	// Follows scanner changes, refreshing only the reads they invalidate, without
	// publishing anything read for another pull request, executor, or checkout.
	syncSelection(): void {
		const entry = this.selectedEntry;
		if (this.selectedKey && (!entry || !this.selectedRepository)) {
			this.clearSelection();
			return;
		}
		if (!this.#visible || !entry) return;
		const scope = this.#selectedScope();
		if (scope !== this.#selectionScope) {
			this.#resetPullRequest();
			this.#selectionScope = scope;
		}
		if (this.status.error === null) this.#followLatestScan();
		this.#followStatus(this.status.ensure(this.#statusKey(entry), this.#readStatus()));
		if (!this.status.isLoading && !this.diff.isLoading) this.#ensureThreads();
		if (entry.historyRevision !== this.#runsVersion) void this.loadRuns();
	}

	// Rereads status and review threads, and retries a failed diff once the new
	// status names its commits.
	refresh(): void {
		const entry = this.selectedEntry;
		if (!this.#visible || !entry || this.#selectionScope !== this.#selectedScope()) return;
		this.diff.forgetFailure();
		this.#followLatestScan();
		this.#followStatus(
			this.status.load(this.#statusKey(entry), this.#readStatus()),
			() => {
				const current = this.selectedEntry;
				if (current)
					this.#followThreads(
						this.reviewThreads.load(
							pullRequestReviewThreadsKey(current.pull),
							this.#readReviewThreads(),
						),
					);
			},
		);
	}

	async loadRuns(): Promise<void> {
		const entry = this.selectedEntry;
		if (entry) await this.#loadRuns(entry, entry.historyRevision);
	}

	selectRun(runId: string): void {
		this.selectedRunId = runId;
		void this.loadRun();
	}

	async loadRun(): Promise<void> {
		const id = this.selectedRunId ?? this.runs[0]?.id;
		if (!id) return;
		this.#runController?.abort();
		const controller = new AbortController();
		this.#runController = controller;
		this.isRunLoading = true;
		this.runError = null;
		this.selectedRun = this.selectedRun?.id === id ? { ...this.selectedRun, review: null } : null;
		try {
			const run = await (this.#deps.getRun ?? getPullRequestReviewRun)(id, {
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			this.selectedRun = run;
		} catch (error) {
			if (!controller.signal.aborted)
				this.runError = errorMessage(error, m.pull_request_reviews_load_failed());
		} finally {
			if (this.#runController === controller) {
				this.#runController = null;
				this.isRunLoading = false;
			}
		}
	}

	async loadMoreRuns(): Promise<void> {
		const entry = this.selectedEntry;
		if (entry && this.nextRunsCursor && !this.isRunsLoading && !this.isMoreRunsLoading)
			await this.#loadRuns(entry, entry.historyRevision, this.nextRunsCursor);
	}

	#selectedScope(): string | null {
		const entry = this.selectedEntry;
		const repository = this.selectedRepository;
		if (!entry || !repository) return null;
		return JSON.stringify([
			entry.repositoryId,
			entry.pull.number,
			effectiveExecutorId(repository.target.executorId),
			repository.target.projectPath,
			repository.nameWithOwner,
			repository.url,
		]);
	}

	#resetPullRequest(): void {
		this.#selectionScope = null;
		this.status.reset();
		this.diff.reset();
		this.reviewThreads.reset();
		this.#coherentChanges = null;
	}

	#selectedTarget(): { readonly target: PullRequestTarget; readonly number: number } | null {
		const entry = this.selectedEntry;
		const repository = this.selectedRepository;
		const identity = repository ? ghRepositoryIdentity(repository) : null;
		if (!entry || !repository || !identity) return null;
		return {
			target: {
				executorId: effectiveExecutorId(repository.target.executorId),
				projectPath: repository.target.projectPath,
				repository: identity,
			},
			number: entry.pull.number,
		};
	}

	// Each reader captures the selection's target when it is created, so a later
	// selection cannot redirect a read in flight.
	#readStatus(): (signal: AbortSignal) => Promise<PullRequestStatus> {
		const selected = this.#selectedTarget();
		const getStatus = this.#deps.getStatus ?? getPullRequestStatus;
		return (signal) =>
			selected ? getStatus(selected.target, selected.number, { signal }) : unreadable();
	}

	#readReviewThreads(): (signal: AbortSignal) => Promise<PullRequestReviewThreads> {
		const selected = this.#selectedTarget();
		const getThreads = this.#deps.getReviewThreads ?? getPullRequestReviewThreads;
		return async (signal) =>
			selected ? await getThreads(selected.target, selected.number, { signal }) : unreadable();
	}

	#followStatus(
		pending: Promise<PullRequestReadOutcome<PullRequestStatus>> | null,
		readThreads: () => void = () => this.#ensureThreads(),
	): void {
		void pending?.then(async (outcome) => {
			if (outcome.kind === 'failed') this.#notify(this.status.error);
			// A newer read or another selection may have replaced this status meanwhile.
			else if (outcome.kind === 'loaded' && this.status.value === outcome.value) {
				await this.#ensureDiff(outcome.value);
				if (this.status.value === outcome.value && !this.status.isLoading) readThreads();
			}
		});
	}

	// The diff follows the commit pair of the latest status. A cached diff is
	// only reused after that status read has confirmed the pair on this executor.
	async #ensureDiff(status: PullRequestStatus): Promise<void> {
		const selected = this.#selectedTarget();
		if (!selected) return;
		const { target, number } = selected;
		const commits = pullRequestDiffCommits(status);
		const key = pullRequestDiffKey(target, number, commits);
		const getDiff = this.#deps.getDiff ?? getPullRequestDiff;
		const pending = this.diff.ensure(key, async (signal) => {
			const cached = this.#diffCache.get(key);
			if (cached) return cached;
			const diff = await getDiff(target, number, commits, { signal });
			this.#diffCache.set(key, diff);
			return diff;
		});
		if (!pending) return;
		const outcome = await pending;
		this.#captureCoherentChanges();
		if (outcome.kind !== 'failed') return;
		if (!isStalePullRequest(outcome.error)) {
			this.#notify(this.diff.error);
			return;
		}
		// The pull request moved after its status was read; the next status names its new commits.
		const entry = this.selectedEntry;
		if (entry && this.diff.key === key && !this.status.isLoading)
			this.#followStatus(this.status.load(this.#statusKey(entry), this.#readStatus()));
	}

	#followLatestScan(): void {
		this.#statusScan = this.selectedRepository?.scan.scannedAt ?? null;
	}

	#statusKey(entry: PullRequestReviewInboxEntry): string {
		return pullRequestStatusKey(entry.pull, this.#statusScan);
	}

	#ensureThreads(): void {
		const entry = this.selectedEntry;
		if (entry)
			this.#followThreads(
				this.reviewThreads.ensure(
					pullRequestReviewThreadsKey(entry.pull),
					this.#readReviewThreads(),
				),
			);
	}

	#followThreads(pending: Promise<PullRequestReadOutcome<PullRequestReviewThreads>> | null): void {
		void pending?.then(() => this.#captureCoherentChanges());
	}

	#captureCoherentChanges(): void {
		const diff = this.diff.value;
		const threads = this.reviewThreads.value;
		if (
			diff &&
			threads &&
			diff.baseRefOid === threads.baseRefOid &&
			diff.headRefOid === threads.headRefOid
		)
			this.#coherentChanges = { diff, threads: threads.threads };
	}

	#notify(message: string | null): void {
		if (message) this.#deps.notifyError?.(message);
	}

	async #loadRuns(
		entry: PullRequestReviewInboxEntry,
		version: number,
		cursor?: string,
	): Promise<void> {
		if (!cursor) this.#runController?.abort();
		this.#runsController?.abort();
		const controller = new AbortController();
		this.#runsController = controller;
		this.#runsVersion = version;
		this.isRunsLoading = !cursor;
		this.isMoreRunsLoading = Boolean(cursor);
		this.runsError = null;
		try {
			const runs = await (this.#deps.getRuns ?? getPullRequestReviewRuns)(
				entry.repositoryId,
				entry.pull.number,
				{
					signal: controller.signal,
					cursor,
				},
			);
			if (controller.signal.aborted) return;
			this.runs = cursor ? [...this.runs, ...runs.runs] : runs.runs;
			this.nextRunsCursor = runs.nextCursor;
			this.runsError = null;
			if (!cursor) await this.loadRun();
		} catch (error) {
			if (controller.signal.aborted) return;
			this.runsError = errorMessage(error, m.pull_request_reviews_load_failed());
		} finally {
			if (this.#runsController === controller) {
				this.#runsController = null;
				this.isRunsLoading = false;
				this.isMoreRunsLoading = false;
			}
		}
	}

	dispose(): void {
		this.clearSelection();
		this.#diffCache.clear();
		this.#visible = false;
	}
}

function unreadable(): Promise<never> {
	return Promise.reject(new Error(m.pull_request_load_failed()));
}

function isStalePullRequest(error: unknown): boolean {
	return error instanceof ApiError && error.errorCode === 'GH_STALE_PULL_REQUEST';
}

export function createPullRequestsStore(deps: PullRequestsStoreDeps): PullRequestsStore {
	return new PullRequestsStore(deps);
}
