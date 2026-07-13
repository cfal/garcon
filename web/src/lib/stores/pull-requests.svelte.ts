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
import * as m from '$lib/paraglide/messages.js';

export interface PullRequestsStoreDeps {
	notifyError?: (message: string) => void;
}

interface PullRequestProjectSnapshot {
	projectPath: string;
	pulls: PullRequestSummary[];
	repoName: string | null;
	hasLoaded: boolean;
	selectedNumber: number | null;
	detail: PullRequestDetail | null;
	accessedAt: number;
}

export class PullRequestsStore {
	#projectPath = $state<string | null>(null);
	#effectiveProjectKey = $state<string | null>(null);
	#visible = $state(false);
	#listGeneration = 0;
	#detailGeneration = 0;
	#listController: AbortController | null = null;
	#detailController: AbortController | null = null;
	#snapshots = new Map<string, PullRequestProjectSnapshot>();
	#needsRefresh = false;
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
	setProject(projectPath: string | null, effectiveProjectKey: string | null = projectPath): void {
		if (effectiveProjectKey === this.#effectiveProjectKey) {
			this.#projectPath = projectPath;
			return;
		}
		this.#listController?.abort();
		this.#detailController?.abort();
		this.#saveSnapshot();
		this.#projectPath = projectPath;
		this.#effectiveProjectKey = effectiveProjectKey;
		this.#listGeneration++;
		this.pulls = [];
		this.repoName = null;
		this.hasLoaded = false;
		this.loadError = null;
		this.clearSelection();
		if (projectPath && effectiveProjectKey) this.#restoreSnapshot(effectiveProjectKey);
		this.#needsRefresh = Boolean(projectPath);
		if (projectPath && this.#visible) void this.refresh();
	}

	setVisible(visible: boolean): void {
		if (visible === this.#visible) return;
		this.#visible = visible;
		if (!visible) {
			this.#listController?.abort();
			this.#detailController?.abort();
			this.isLoading = false;
			this.isDetailLoading = false;
			this.#needsRefresh = Boolean(this.#projectPath);
			return;
		}
		if (this.#projectPath && (!this.hasLoaded || this.#needsRefresh)) void this.refresh();
	}

	toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
	}

	async refresh(): Promise<void> {
		const projectPath = this.#projectPath;
		if (!projectPath || !this.#visible) return;
		this.#listController?.abort();
		const controller = new AbortController();
		this.#listController = controller;
		const generation = ++this.#listGeneration;
		this.isLoading = true;
		this.loadError = null;
		try {
			const result = await getPullRequests(projectPath, { signal: controller.signal });
			if (controller.signal.aborted || generation !== this.#listGeneration) return;
			this.pulls = result.pulls;
			this.repoName = result.repo?.nameWithOwner ?? null;
			this.hasLoaded = true;
		} catch (error) {
			if (controller.signal.aborted) return;
			if (generation !== this.#listGeneration) return;
			this.loadError = errorMessage(error, m.pull_requests_load_failed());
			this.hasLoaded = true;
		} finally {
			if (generation === this.#listGeneration) {
				this.isLoading = false;
				if (!controller.signal.aborted) this.#needsRefresh = false;
				if (this.#listController === controller) this.#listController = null;
			}
		}
	}

	async select(number: number): Promise<void> {
		if (!this.#projectPath) return;
		this.selectedNumber = number;
		await this.loadDetail(number);
	}

	async loadDetail(number: number): Promise<void> {
		const projectPath = this.#projectPath;
		if (!projectPath || !this.#visible) return;
		this.#detailController?.abort();
		const controller = new AbortController();
		this.#detailController = controller;
		const generation = ++this.#detailGeneration;
		this.isDetailLoading = true;
		this.detailError = null;
		if (this.detail?.number !== number) this.detail = null;
		try {
			const detail = await getPullRequest(projectPath, number, { signal: controller.signal });
			if (controller.signal.aborted || generation !== this.#detailGeneration) return;
			this.detail = detail;
		} catch (error) {
			if (controller.signal.aborted) return;
			if (generation !== this.#detailGeneration) return;
			const message = errorMessage(error, m.pull_request_load_failed());
			this.detailError = message;
			this.#deps.notifyError?.(message);
		} finally {
			if (generation === this.#detailGeneration) {
				this.isDetailLoading = false;
				if (this.#detailController === controller) this.#detailController = null;
			}
		}
	}

	clearSelection(): void {
		this.#detailController?.abort();
		this.#detailController = null;
		this.#detailGeneration++;
		this.selectedNumber = null;
		this.detail = null;
		this.detailError = null;
		this.isDetailLoading = false;
	}

	disposeSurface(): void {
		this.#listController?.abort();
		this.#detailController?.abort();
		this.#listController = null;
		this.#detailController = null;
		this.#listGeneration += 1;
		this.#detailGeneration += 1;
		this.#projectPath = null;
		this.#effectiveProjectKey = null;
		this.#snapshots.clear();
		this.#needsRefresh = false;
		this.#visible = false;
		this.pulls = [];
		this.repoName = null;
		this.isLoading = false;
		this.loadError = null;
		this.hasLoaded = false;
		this.collapsed = false;
		this.selectedNumber = null;
		this.detail = null;
		this.isDetailLoading = false;
		this.detailError = null;
	}

	#saveSnapshot(): void {
		const effectiveProjectKey = this.#effectiveProjectKey;
		const projectPath = this.#projectPath;
		if (!effectiveProjectKey || !projectPath) return;
		this.#snapshots.delete(effectiveProjectKey);
		this.#snapshots.set(effectiveProjectKey, {
			projectPath,
			pulls: this.pulls,
			repoName: this.repoName,
			hasLoaded: this.hasLoaded,
			selectedNumber: this.selectedNumber,
			detail: this.detail,
			accessedAt: Date.now(),
		});
		while (this.#snapshots.size > 8) {
			const oldest = this.#snapshots.keys().next().value;
			if (!oldest) break;
			this.#snapshots.delete(oldest);
		}
	}

	#restoreSnapshot(effectiveProjectKey: string): void {
		const snapshot = this.#snapshots.get(effectiveProjectKey);
		if (!snapshot) return;
		this.#snapshots.delete(effectiveProjectKey);
		this.#snapshots.set(effectiveProjectKey, { ...snapshot, accessedAt: Date.now() });
		this.pulls = snapshot.pulls;
		this.repoName = snapshot.repoName;
		this.hasLoaded = snapshot.hasLoaded;
		this.selectedNumber = snapshot.selectedNumber;
		this.detail = snapshot.detail;
	}
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function createPullRequestsStore(deps: PullRequestsStoreDeps = {}): PullRequestsStore {
	return new PullRequestsStore(deps);
}
