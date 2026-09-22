import type { GitProjectTarget } from '$lib/api/git-client.js';
import { gitProjectKey, sameGitProject } from '$lib/git/targets/git-target.js';
import {
	getGitQuickSummary,
	type GitQuickSummaryReady,
	type GitQuickSummaryResponse,
} from '$lib/api/git.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

export const QUICK_GIT_IDLE_POLL_MS = 15_000;
export const QUICK_GIT_PROCESSING_POLL_MS = 90_000;
export const QUICK_GIT_STOPPED_DEBOUNCE_MS = 500;
export const QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS = 100;
export const QUICK_GIT_CACHE_MAX_ENTRIES = 8;
export const QUICK_GIT_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

export type GitQuickRefreshReason =
	| 'project-change'
	| 'tray-visible'
	| 'agent-stopped'
	| 'agent-processing-poll'
	| 'idle-poll'
	| 'dialog-open'
	| 'dialog-mutation'
	| 'commit-complete'
	| 'visibility'
	| 'invalidation';

interface QuickSummaryDocument {
	visibilityState: DocumentVisibilityState;
	addEventListener: Document['addEventListener'];
	removeEventListener: Document['removeEventListener'];
}

type QuickSummaryTimeoutHandle = ReturnType<typeof setTimeout>;
type QuickSummaryIntervalHandle = ReturnType<typeof setInterval>;
type QuickSummarySetTimeout = (callback: () => void, delayMs: number) => QuickSummaryTimeoutHandle;
type QuickSummarySetInterval = (
	callback: () => void,
	delayMs: number,
) => QuickSummaryIntervalHandle;
type QuickSummaryClearTimeout = (handle: QuickSummaryTimeoutHandle) => void;
type QuickSummaryClearInterval = (handle: QuickSummaryIntervalHandle) => void;
type QuickSummaryNow = () => number;

type GitQuickCachedStatus = 'unknown' | 'ready' | 'not-git-repository' | 'error';

interface GitQuickSummaryCacheEntry {
	project: GitProjectTarget;
	status: GitQuickCachedStatus;
	summary: GitQuickSummaryReady | null;
	lastError: string | null;
	hasResponse: boolean;
	isRefreshing: boolean;
	lastAccessedAt: number;
	lastUpdatedAt: number;
}

export interface GitQuickProjectLease extends GitProjectTarget {
	readonly nodeContextKey?: string;
	readonly isProcessing: boolean;
}

const setGlobalTimeout: QuickSummarySetTimeout = (callback, delayMs) =>
	globalThis.setTimeout(callback, delayMs);
const clearGlobalTimeout: QuickSummaryClearTimeout = (handle) => {
	globalThis.clearTimeout(handle);
};
const setGlobalInterval: QuickSummarySetInterval = (callback, delayMs) =>
	globalThis.setInterval(callback, delayMs);
const clearGlobalInterval: QuickSummaryClearInterval = (handle) => {
	globalThis.clearInterval(handle);
};

interface GitQuickSummaryStoreDeps {
	getSummary?: typeof getGitQuickSummary;
	setTimeoutFn?: QuickSummarySetTimeout;
	clearTimeoutFn?: QuickSummaryClearTimeout;
	nowFn?: QuickSummaryNow;
}

interface QuickSummaryPollingOptions {
	documentRef?: QuickSummaryDocument;
	setIntervalFn?: QuickSummarySetInterval;
	clearIntervalFn?: QuickSummaryClearInterval;
}

function canPollCommitSummary(
	documentRef: Pick<QuickSummaryDocument, 'visibilityState'> | undefined = globalThis.document,
): boolean {
	return !documentRef || documentRef.visibilityState === 'visible';
}

function systemNow(): number {
	return Date.now();
}

export class GitQuickSummaryStore {
	project = $state<GitProjectTarget | null>(null);
	visibleProjects = $state.raw<readonly GitQuickProjectLease[]>([]);
	entries = $state<Record<string, GitQuickSummaryCacheEntry>>({});
	isEnabled = $state(true);

	private readonly requestGenerationByProject = new Map<string, number>();
	private requestSequence = 0;
	private readonly inFlightByProject = new Map<string, AbortController>();
	private readonly pendingRefreshByProject = new Map<string, GitQuickRefreshReason>();
	private readonly debounceTimerByProject = new Map<string, QuickSummaryTimeoutHandle>();
	private readonly getSummary: typeof getGitQuickSummary;
	private readonly setTimeoutFn: QuickSummarySetTimeout;
	private readonly clearTimeoutFn: QuickSummaryClearTimeout;
	private readonly now: QuickSummaryNow;
	#ownedPollingKey = '';
	#stopOwnedPolling: (() => void) | null = null;

	constructor(deps: GitQuickSummaryStoreDeps = {}) {
		this.getSummary = deps.getSummary ?? getGitQuickSummary;
		this.setTimeoutFn = deps.setTimeoutFn ?? setGlobalTimeout;
		this.clearTimeoutFn = deps.clearTimeoutFn ?? clearGlobalTimeout;
		this.now = deps.nowFn ?? systemNow;
	}

	get activeEntry(): GitQuickSummaryCacheEntry | null {
		return this.entryFor(this.project);
	}

	get summary(): GitQuickSummaryReady | null {
		return this.activeEntry?.summary ?? null;
	}

	get lastNonRepoProject(): string | null {
		const entry = this.activeEntry;
		return entry?.status === 'not-git-repository' ? entry.project.projectPath : null;
	}

	get isLoading(): boolean {
		return Boolean(this.activeEntry?.isRefreshing);
	}

	get lastError(): string | null {
		return this.activeEntry?.lastError ?? null;
	}

	get hasReadyResponseForCurrentProject(): boolean {
		return this.activeEntry?.status === 'ready';
	}

	get canShowTray(): boolean {
		return this.canShowTrayFor(this.project);
	}

	canShowTrayFor(project: GitProjectTarget | null): boolean {
		if (!this.isEnabled || !project) return false;
		const entry = this.entryFor(project);
		if (!entry) return true;
		if (entry.status === 'not-git-repository') return false;
		if (entry.summary) return true;
		if (entry.status === 'error') return Boolean(entry.lastError);
		return !entry.hasResponse;
	}

	get hasChanges(): boolean {
		return Boolean(this.summary && this.summary.changedFiles > 0);
	}

	summaryFor(project: GitProjectTarget | null): GitQuickSummaryReady | null {
		return this.entryFor(project)?.summary ?? null;
	}

	lastErrorFor(project: GitProjectTarget | null): string | null {
		return this.entryFor(project)?.lastError ?? null;
	}

	isRefreshingFor(project: GitProjectTarget | null): boolean {
		return Boolean(this.entryFor(project)?.isRefreshing);
	}

	setProject(project: GitProjectTarget | null): void {
		if (sameGitProject(project, this.project)) return;
		this.project = project;
		if (project) {
			this.touchProject(project);
			this.pruneCache();
			if (this.#hasVisibleProject(project) && this.isEnabled) {
				this.scheduleRefreshFor(project, 'project-change', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
			}
		}
	}

	setVisibleProjects(projects: readonly GitQuickProjectLease[]): void {
		const deduplicated = new Map<string, GitQuickProjectLease>();
		for (const project of projects) {
			if (!project.projectPath) continue;
			const previous = deduplicated.get(gitProjectKey(project));
			deduplicated.set(gitProjectKey(project), {
				...project,
				isProcessing: Boolean(previous?.isProcessing || project.isProcessing),
			});
		}
		const next = [...deduplicated.values()].sort((left, right) =>
			gitProjectKey(left).localeCompare(gitProjectKey(right)),
		);
		const previous = new Map(
			this.visibleProjects.map((project) => [gitProjectKey(project), project]),
		);
		if (
			next.length === this.visibleProjects.length &&
			next.every((project, index) => {
				const current = this.visibleProjects[index];
				return (
					sameGitProject(current, project) &&
					current.nodeContextKey === project.nodeContextKey &&
					current.isProcessing === project.isProcessing
				);
			})
		) {
			return;
		}

		const nextPaths = new Set(next.map(gitProjectKey));
		for (const project of this.visibleProjects) {
			if (nextPaths.has(gitProjectKey(project))) continue;
			this.#cancelProjectWork(project);
			this.updateEntry(project, { isRefreshing: false });
		}

		this.visibleProjects = next;
		for (const project of next) {
			this.touchProject(project);
			const previousLease = previous.get(gitProjectKey(project));
			if (!this.isEnabled) continue;
			if (!previousLease || previousLease.nodeContextKey !== project.nodeContextKey) {
				this.#cancelProjectWork(project);
				this.updateEntry(project, { isRefreshing: false });
				this.scheduleRefreshFor(project, 'project-change', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
			} else if (previousLease.isProcessing && !project.isProcessing) {
				this.scheduleRefreshFor(project, 'agent-stopped', QUICK_GIT_STOPPED_DEBOUNCE_MS);
			}
		}
		this.pruneCache();
	}

	setEnabled(enabled: boolean): void {
		if (enabled === this.isEnabled) return;
		this.isEnabled = enabled;
		if (!enabled) {
			for (const project of this.visibleProjects) {
				this.#cancelProjectWork(project);
				this.updateEntry(project, { isRefreshing: false });
			}
			return;
		}
		for (const project of this.visibleProjects) {
			this.touchProject(project);
			this.scheduleRefreshFor(project, 'tray-visible', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
		}
		this.pruneCache();
	}

	scheduleRefresh(reason: GitQuickRefreshReason, delayMs = 300): void {
		if (!this.project) return;
		this.scheduleRefreshFor(this.project, reason, delayMs);
	}

	scheduleRefreshFor(
		project: GitProjectTarget,
		reason: GitQuickRefreshReason,
		delayMs = 300,
	): void {
		if (!this.isEnabled || !this.#hasVisibleProject(project)) return;
		this.pendingRefreshByProject.set(gitProjectKey(project), reason);
		this.#clearProjectDebounce(project);
		const timer = this.setTimeoutFn(() => {
			this.debounceTimerByProject.delete(gitProjectKey(project));
			const pendingReason = this.pendingRefreshByProject.get(gitProjectKey(project)) ?? reason;
			this.pendingRefreshByProject.delete(gitProjectKey(project));
			void this.refreshFor(project, pendingReason);
		}, delayMs);
		this.debounceTimerByProject.set(gitProjectKey(project), timer);
	}

	async refresh(reason: GitQuickRefreshReason): Promise<void> {
		if (!this.project) return;
		await this.refreshFor(this.project, reason);
	}

	async refreshFor(project: GitProjectTarget, _reason: GitQuickRefreshReason): Promise<void> {
		if (!this.isEnabled || !this.#hasVisibleProject(project)) return;
		this.#clearProjectDebounce(project);
		this.pendingRefreshByProject.delete(gitProjectKey(project));
		const generation = ++this.requestSequence;
		this.requestGenerationByProject.set(gitProjectKey(project), generation);
		this.inFlightByProject.get(gitProjectKey(project))?.abort();
		const controller = new AbortController();
		this.inFlightByProject.set(gitProjectKey(project), controller);
		this.updateEntry(project, { isRefreshing: true, lastAccessedAt: this.now() });

		try {
			const result = await this.getSummary(project, { signal: controller.signal });
			if (!this.isCurrentResponse(project, generation)) return;
			this.applyResponse(project, result);
			this.pruneCache();
		} catch (error) {
			if (isAbortError(error) || !this.isCurrentResponse(project, generation)) return;
			this.applyRefreshError(project, error);
			this.pruneCache();
		} finally {
			if (this.inFlightByProject.get(gitProjectKey(project)) === controller) {
				this.inFlightByProject.delete(gitProjectKey(project));
			}
			if (this.isCurrentResponse(project, generation)) {
				this.updateEntry(project, { isRefreshing: false });
			}
		}
	}

	startPolling({
		documentRef = globalThis.document,
		setIntervalFn = setGlobalInterval,
		clearIntervalFn = clearGlobalInterval,
	}: QuickSummaryPollingOptions = {}): () => void {
		if (this.visibleProjects.length === 0 || !this.isEnabled) return () => {};
		const intervalMs = this.visibleProjects.every((project) => project.isProcessing)
			? QUICK_GIT_PROCESSING_POLL_MS
			: QUICK_GIT_IDLE_POLL_MS;
		const tick = (reason: GitQuickRefreshReason): void => {
			if (!this.isEnabled || !canPollCommitSummary(documentRef)) return;
			for (const project of this.visibleProjects) {
				if (
					reason !== 'visibility' &&
					project.isProcessing &&
					this.now() - (this.entryFor(project)?.lastUpdatedAt ?? 0) < QUICK_GIT_PROCESSING_POLL_MS
				) {
					continue;
				}
				let refreshReason: GitQuickRefreshReason;
				if (reason === 'visibility') refreshReason = reason;
				else if (project.isProcessing) refreshReason = 'agent-processing-poll';
				else refreshReason = 'idle-poll';
				void this.refreshFor(project, refreshReason);
			}
		};
		const intervalId = setIntervalFn(() => tick('idle-poll'), intervalMs);
		const handleVisibilityChange = (): void => {
			tick('visibility');
		};

		documentRef?.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			clearIntervalFn(intervalId);
			documentRef?.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}

	reconcilePolling(options: QuickSummaryPollingOptions = {}): void {
		const nextKey =
			this.isEnabled && this.visibleProjects.length > 0 ? JSON.stringify(this.visibleProjects) : '';
		if (nextKey === this.#ownedPollingKey) return;
		this.#stopOwnedPolling?.();
		this.#stopOwnedPolling = null;
		this.#ownedPollingKey = nextKey;
		if (nextKey) this.#stopOwnedPolling = this.startPolling(options);
	}

	destroy(): void {
		this.#stopOwnedPolling?.();
		this.#stopOwnedPolling = null;
		this.#ownedPollingKey = '';
		for (const project of this.visibleProjects) this.#cancelProjectWork(project);
		this.visibleProjects = [];
		this.entries = {};
		this.requestGenerationByProject.clear();
	}

	pruneNodes(nodeIds: ReadonlySet<string>): void {
		this.setVisibleProjects(this.visibleProjects.filter((project) => nodeIds.has(project.nodeId)));
		for (const entry of Object.values(this.entries)) {
			if (!nodeIds.has(entry.project.nodeId)) this.#cancelProjectWork(entry.project);
		}
		if (this.project && !nodeIds.has(this.project.nodeId)) this.project = null;
		this.entries = Object.fromEntries(
			Object.entries(this.entries).filter(([, entry]) => nodeIds.has(entry.project.nodeId)),
		);
		this.pruneCache();
	}

	private applyResponse(project: GitProjectTarget, result: GitQuickSummaryResponse): void {
		const now = this.now();
		if (result.status === 'ready') {
			this.updateEntry(project, {
				status: 'ready',
				summary: result,
				lastError: null,
				hasResponse: true,
				isRefreshing: false,
				lastAccessedAt: now,
				lastUpdatedAt: now,
			});
			return;
		}

		if (result.status === 'not-git-repository') {
			this.updateEntry(project, {
				status: 'not-git-repository',
				summary: null,
				lastError: null,
				hasResponse: true,
				isRefreshing: false,
				lastAccessedAt: now,
				lastUpdatedAt: now,
			});
			return;
		}

		this.applySummaryError(project, result.message, now);
	}

	private isCurrentResponse(project: GitProjectTarget, generation: number): boolean {
		return (
			generation === this.requestGenerationByProject.get(gitProjectKey(project)) &&
			this.#hasVisibleProject(project) &&
			this.isEnabled
		);
	}

	private applyRefreshError(project: GitProjectTarget, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.applySummaryError(project, message, this.now());
	}

	private applySummaryError(project: GitProjectTarget, message: string, now: number): void {
		const existing = this.entryFor(project);
		this.updateEntry(project, {
			status: existing?.summary ? 'ready' : 'error',
			lastError: message,
			hasResponse: true,
			isRefreshing: false,
			lastAccessedAt: now,
			lastUpdatedAt: now,
		});
	}

	private entryFor(project: GitProjectTarget | null): GitQuickSummaryCacheEntry | null {
		if (!project) return null;
		return this.entries[gitProjectKey(project)] ?? null;
	}

	private touchProject(project: GitProjectTarget): void {
		this.updateEntry(project, { lastAccessedAt: this.now() });
	}

	private updateEntry(project: GitProjectTarget, patch: Partial<GitQuickSummaryCacheEntry>): void {
		const existing = this.entryFor(project) ?? this.createEntry(project);
		this.entries = {
			...this.entries,
			[gitProjectKey(project)]: {
				...existing,
				...patch,
				project,
			},
		};
	}

	private createEntry(project: GitProjectTarget): GitQuickSummaryCacheEntry {
		const now = this.now();
		return {
			project,
			status: 'unknown',
			summary: null,
			lastError: null,
			hasResponse: false,
			isRefreshing: false,
			lastAccessedAt: now,
			lastUpdatedAt: 0,
		};
	}

	private pruneCache(): void {
		const now = this.now();
		const protectedPaths = new Set(this.visibleProjects.map(gitProjectKey));
		if (this.project) protectedPaths.add(gitProjectKey(this.project));
		const protectedEntries = [...protectedPaths].flatMap((key) => {
			const entry = this.entries[key];
			return entry ? [entry] : [];
		});
		const retained = Object.values(this.entries)
			.filter((entry) => {
				if (protectedPaths.has(gitProjectKey(entry.project))) return false;
				return now - entry.lastAccessedAt <= QUICK_GIT_CACHE_MAX_AGE_MS;
			})
			.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
		const bounded = [...protectedEntries, ...retained].slice(0, QUICK_GIT_CACHE_MAX_ENTRIES);

		this.entries = Object.fromEntries(
			bounded.map((entry) => [gitProjectKey(entry.project), entry]),
		);
		for (const key of this.requestGenerationByProject.keys()) {
			if (!this.entries[key] && !this.inFlightByProject.has(key))
				this.requestGenerationByProject.delete(key);
		}
	}

	#hasVisibleProject(target: GitProjectTarget): boolean {
		return this.visibleProjects.some((project) => sameGitProject(project, target));
	}

	#cancelProjectWork(project: GitProjectTarget): void {
		this.#clearProjectDebounce(project);
		this.pendingRefreshByProject.delete(gitProjectKey(project));
		this.requestGenerationByProject.delete(gitProjectKey(project));
		this.inFlightByProject.get(gitProjectKey(project))?.abort();
		this.inFlightByProject.delete(gitProjectKey(project));
	}

	#clearProjectDebounce(project: GitProjectTarget): void {
		const timer = this.debounceTimerByProject.get(gitProjectKey(project));
		if (timer === undefined) return;
		this.clearTimeoutFn(timer);
		this.debounceTimerByProject.delete(gitProjectKey(project));
	}
}
