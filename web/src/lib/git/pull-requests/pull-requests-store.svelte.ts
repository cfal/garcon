// Owns one Pull Requests surface: the inbox selection, search, the selected
// pull request's detail from its repository's executor, and that pull
// request's review runs. The inbox itself comes from the shared review store,
// so it shows the last scan immediately instead of waiting on GitHub.

import { getPullRequest, type PullRequestDetail } from '$lib/api/pull-requests.js';
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
import type { PullRequestReviewsStore } from './pull-request-reviews-store.svelte.js';

export type PullRequestDetailTab = 'review' | 'changes' | 'checks';

export interface PullRequestsStoreDeps {
	reviews: PullRequestReviewsStore;
	notifyError?: (message: string) => void;
	getDetail?: typeof getPullRequest;
	getRuns?: typeof getPullRequestReviewRuns;
	getRun?: typeof getPullRequestReviewRun;
}

export class PullRequestsStore implements PortableSingletonController {
	readonly reviews: PullRequestReviewsStore;
	readonly #deps: PullRequestsStoreDeps;
	#visible = false;
	#detailController: AbortController | null = null;
	#detailVersion: string | null = null;
	#runsController: AbortController | null = null;
	#runController: AbortController | null = null;
	#runsVersion: number | null = null;

	query = $state('');
	repositoryFilter = $state<string | null>(null);
	selectedKey = $state<string | null>(null);
	tab = $state<PullRequestDetailTab>('review');
	detail = $state<PullRequestDetail | null>(null);
	isDetailLoading = $state(false);
	detailError = $state<string | null>(null);
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
		this.#detailController?.abort();
		this.#runsController?.abort();
		this.#runController?.abort();
		this.#detailController = null;
		this.#detailVersion = null;
		this.#runsController = null;
		this.#runController = null;
		this.#runsVersion = null;
		this.selectedKey = null;
		this.selectedRunId = null;
		this.detail = null;
		this.detailError = null;
		this.isDetailLoading = false;
		this.runs = [];
		this.nextRunsCursor = null;
		this.isMoreRunsLoading = false;
		this.isRunsLoading = false;
		this.runsError = null;
		this.selectedRun = null;
		this.isRunLoading = false;
		this.runError = null;
	}

	// Follows scanner changes without publishing detail from an earlier head or executor.
	syncSelection(): void {
		const entry = this.selectedEntry;
		if (this.selectedKey && (!entry || !this.selectedRepository)) {
			this.clearSelection();
			return;
		}
		if (!this.#visible || !entry) return;
		if (this.#selectedDetailVersion() !== this.#detailVersion) {
			this.detail = null;
			void this.loadDetail();
		}
		if (entry.historyRevision !== this.#runsVersion) void this.loadRuns();
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

	async loadDetail(): Promise<void> {
		const entry = this.selectedEntry;
		const repository = this.selectedRepository;
		if (!entry || !repository) return;
		const version = this.#selectedDetailVersion();
		this.#detailVersion = version;
		this.#detailController?.abort();
		const controller = new AbortController();
		this.#detailController = controller;
		this.isDetailLoading = true;
		this.detailError = null;
		try {
			const identity = ghRepositoryIdentity(repository);
			if (!identity) throw new Error(m.pull_request_load_failed());
			const detail = await (this.#deps.getDetail ?? getPullRequest)(
				{
					executorId: effectiveExecutorId(repository.target.executorId),
					projectPath: repository.target.projectPath,
					repository: identity,
				},
				entry.pull.number,
				{ signal: controller.signal },
			);
			if (controller.signal.aborted || version !== this.#selectedDetailVersion()) return;
			this.detail = detail;
		} catch (error) {
			if (controller.signal.aborted || version !== this.#selectedDetailVersion()) return;
			const message = errorMessage(error, m.pull_request_load_failed());
			this.detail = null;
			this.detailError = message;
			this.#deps.notifyError?.(message);
		} finally {
			if (this.#detailController === controller) {
				this.#detailController = null;
				this.isDetailLoading = false;
			}
		}
	}

	#selectedDetailVersion(): string | null {
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
			entry.pull.headRefOid,
			entry.pull.updatedAt,
			entry.pull.checksState,
			entry.pull.reviewDecision,
		]);
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
		this.#visible = false;
	}
}

export function createPullRequestsStore(deps: PullRequestsStoreDeps): PullRequestsStore {
	return new PullRequestsStore(deps);
}
