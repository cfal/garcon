// Reactive store for the GitHub pull request viewer. Owns the PR list for the
// active project plus the currently selected PR's detail (diff + threads).
// Selecting a PR loads its detail lazily; generation guards drop stale
// responses when the project or selection changes mid-flight.

import {
	getPullRequest,
	getPullRequests,
	type PullRequestDetail,
	type PullRequestSummary,
} from '$lib/api/pull-requests.js';

export interface PullRequestsStoreDeps {
	notifyError?: (message: string) => void;
}

export class PullRequestsStore {
	#projectPath = $state<string | null>(null);
	#listGeneration = 0;
	#detailGeneration = 0;
	#deps: PullRequestsStoreDeps;

	pulls = $state<PullRequestSummary[]>([]);
	repoName = $state<string | null>(null);
	isLoading = $state(false);
	loadError = $state<string | null>(null);
	hasLoaded = $state(false);
	collapsed = $state(false);

	selectedNumber = $state<number | null>(null);
	detail = $state<PullRequestDetail | null>(null);
	isDetailLoading = $state(false);
	detailError = $state<string | null>(null);

	constructor(deps: PullRequestsStoreDeps = {}) {
		this.#deps = deps;
	}

	get projectPath(): string | null {
		return this.#projectPath;
	}

	get hasSelection(): boolean {
		return this.selectedNumber !== null;
	}

	get selectedSummary(): PullRequestSummary | null {
		return this.pulls.find((pr) => pr.number === this.selectedNumber) ?? null;
	}

	// Points the store at a project. Clears state and reloads when it changes.
	setProject(projectPath: string | null): void {
		if (projectPath === this.#projectPath) return;
		this.#projectPath = projectPath;
		this.pulls = [];
		this.repoName = null;
		this.hasLoaded = false;
		this.loadError = null;
		this.clearSelection();
		if (projectPath) void this.refresh();
	}

	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
	}

	async refresh(): Promise<void> {
		const projectPath = this.#projectPath;
		if (!projectPath) return;
		const generation = ++this.#listGeneration;
		this.isLoading = true;
		this.loadError = null;
		try {
			const result = await getPullRequests(projectPath);
			if (generation !== this.#listGeneration) return;
			this.pulls = result.pulls;
			this.repoName = result.repo?.nameWithOwner ?? null;
			this.hasLoaded = true;
		} catch (error) {
			if (generation !== this.#listGeneration) return;
			this.loadError = errorMessage(error, 'Failed to load pull requests.');
			this.hasLoaded = true;
		} finally {
			if (generation === this.#listGeneration) this.isLoading = false;
		}
	}

	async select(number: number): Promise<void> {
		if (!this.#projectPath) return;
		this.selectedNumber = number;
		await this.loadDetail(number);
	}

	async loadDetail(number: number): Promise<void> {
		const projectPath = this.#projectPath;
		if (!projectPath) return;
		const generation = ++this.#detailGeneration;
		this.isDetailLoading = true;
		this.detailError = null;
		if (this.detail?.number !== number) this.detail = null;
		try {
			const detail = await getPullRequest(projectPath, number);
			if (generation !== this.#detailGeneration) return;
			this.detail = detail;
		} catch (error) {
			if (generation !== this.#detailGeneration) return;
			const message = errorMessage(error, 'Failed to load pull request.');
			this.detailError = message;
			this.#deps.notifyError?.(message);
		} finally {
			if (generation === this.#detailGeneration) this.isDetailLoading = false;
		}
	}

	clearSelection(): void {
		this.#detailGeneration++;
		this.selectedNumber = null;
		this.detail = null;
		this.detailError = null;
		this.isDetailLoading = false;
	}
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function createPullRequestsStore(deps: PullRequestsStoreDeps = {}): PullRequestsStore {
	return new PullRequestsStore(deps);
}
