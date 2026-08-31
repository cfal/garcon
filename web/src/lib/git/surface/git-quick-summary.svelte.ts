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
	projectPath: string;
	status: GitQuickCachedStatus;
	summary: GitQuickSummaryReady | null;
	lastError: string | null;
	hasResponse: boolean;
	isRefreshing: boolean;
	lastAccessedAt: number;
	lastUpdatedAt: number;
}

export interface GitQuickProjectLease {
	readonly projectPath: string;
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
	projectPath = $state<string | null>(null);
	visibleProjects = $state.raw<readonly GitQuickProjectLease[]>([]);
	entries = $state<Record<string, GitQuickSummaryCacheEntry>>({});
	isEnabled = $state(true);

	private readonly requestGenerationByProject = new Map<string, number>();
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
		return this.entryFor(this.projectPath);
	}

	get summary(): GitQuickSummaryReady | null {
		return this.activeEntry?.summary ?? null;
	}

	get lastNonRepoProject(): string | null {
		const entry = this.activeEntry;
		return entry?.status === 'not-git-repository' ? entry.projectPath : null;
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
		return this.canShowTrayFor(this.projectPath);
	}

	canShowTrayFor(projectPath: string | null): boolean {
		if (!this.isEnabled || !projectPath) return false;
		const entry = this.entryFor(projectPath);
		if (!entry) return true;
		if (entry.status === 'not-git-repository') return false;
		if (entry.summary) return true;
		if (entry.status === 'error') return Boolean(entry.lastError);
		return !entry.hasResponse;
	}

	get hasChanges(): boolean {
		return Boolean(this.summary && this.summary.changedFiles > 0);
	}

	summaryFor(projectPath: string | null): GitQuickSummaryReady | null {
		return this.entryFor(projectPath)?.summary ?? null;
	}

	lastErrorFor(projectPath: string | null): string | null {
		return this.entryFor(projectPath)?.lastError ?? null;
	}

	isRefreshingFor(projectPath: string | null): boolean {
		return Boolean(this.entryFor(projectPath)?.isRefreshing);
	}

	setProject(projectPath: string | null): void {
		if (projectPath === this.projectPath) return;
		this.projectPath = projectPath;
		if (projectPath) {
			this.touchProject(projectPath);
			this.pruneCache();
			if (this.#hasVisibleProject(projectPath) && this.isEnabled) {
				this.scheduleRefreshFor(
					projectPath,
					'project-change',
					QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS,
				);
			}
		}
	}

	setVisibleProjects(projects: readonly GitQuickProjectLease[]): void {
		const deduplicated = new Map<string, GitQuickProjectLease>();
		for (const project of projects) {
			if (!project.projectPath) continue;
			const previous = deduplicated.get(project.projectPath);
			deduplicated.set(project.projectPath, {
				projectPath: project.projectPath,
				isProcessing: Boolean(previous?.isProcessing || project.isProcessing),
			});
		}
		const next = [...deduplicated.values()].sort((left, right) =>
			left.projectPath.localeCompare(right.projectPath),
		);
		const previous = new Map(this.visibleProjects.map((project) => [project.projectPath, project]));
		if (
			next.length === this.visibleProjects.length &&
			next.every((project, index) => {
				const current = this.visibleProjects[index];
				return (
					current?.projectPath === project.projectPath &&
					current.isProcessing === project.isProcessing
				);
			})
		) {
			return;
		}

		const nextPaths = new Set(next.map((project) => project.projectPath));
		for (const project of this.visibleProjects) {
			if (nextPaths.has(project.projectPath)) continue;
			this.#cancelProjectWork(project.projectPath);
			this.updateEntry(project.projectPath, { isRefreshing: false });
		}

		this.visibleProjects = next;
		for (const project of next) {
			this.touchProject(project.projectPath);
			const previousLease = previous.get(project.projectPath);
			if (!this.isEnabled) continue;
			if (!previousLease) {
				this.scheduleRefreshFor(
					project.projectPath,
					'project-change',
					QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS,
				);
			} else if (previousLease.isProcessing && !project.isProcessing) {
				this.scheduleRefreshFor(
					project.projectPath,
					'agent-stopped',
					QUICK_GIT_STOPPED_DEBOUNCE_MS,
				);
			}
		}
		this.pruneCache();
	}

	setEnabled(enabled: boolean): void {
		if (enabled === this.isEnabled) return;
		this.isEnabled = enabled;
		if (!enabled) {
			for (const project of this.visibleProjects) {
				this.#cancelProjectWork(project.projectPath);
				this.updateEntry(project.projectPath, { isRefreshing: false });
			}
			return;
		}
		for (const project of this.visibleProjects) {
			this.touchProject(project.projectPath);
			this.scheduleRefreshFor(
				project.projectPath,
				'tray-visible',
				QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS,
			);
		}
		this.pruneCache();
	}

	scheduleRefresh(reason: GitQuickRefreshReason, delayMs = 300): void {
		if (!this.projectPath) return;
		this.scheduleRefreshFor(this.projectPath, reason, delayMs);
	}

	scheduleRefreshFor(
		projectPath: string,
		reason: GitQuickRefreshReason,
		delayMs = 300,
	): void {
		if (!this.isEnabled || !this.#hasVisibleProject(projectPath)) return;
		this.pendingRefreshByProject.set(projectPath, reason);
		this.#clearProjectDebounce(projectPath);
		const timer = this.setTimeoutFn(() => {
			this.debounceTimerByProject.delete(projectPath);
			const pendingReason = this.pendingRefreshByProject.get(projectPath) ?? reason;
			this.pendingRefreshByProject.delete(projectPath);
			void this.refreshFor(projectPath, pendingReason);
		}, delayMs);
		this.debounceTimerByProject.set(projectPath, timer);
	}

	async refresh(reason: GitQuickRefreshReason): Promise<void> {
		if (!this.projectPath) return;
		await this.refreshFor(this.projectPath, reason);
	}

	async refreshFor(projectPath: string, _reason: GitQuickRefreshReason): Promise<void> {
		if (!this.isEnabled || !this.#hasVisibleProject(projectPath)) return;
		this.#clearProjectDebounce(projectPath);
		this.pendingRefreshByProject.delete(projectPath);
		const generation = (this.requestGenerationByProject.get(projectPath) ?? 0) + 1;
		this.requestGenerationByProject.set(projectPath, generation);
		this.inFlightByProject.get(projectPath)?.abort();
		const controller = new AbortController();
		this.inFlightByProject.set(projectPath, controller);
		this.updateEntry(projectPath, { isRefreshing: true, lastAccessedAt: this.now() });

		try {
			const result = await this.getSummary(projectPath, { signal: controller.signal });
			if (!this.isCurrentResponse(projectPath, generation)) return;
			this.applyResponse(projectPath, result);
			this.pruneCache();
		} catch (error) {
			if (isAbortError(error) || !this.isCurrentResponse(projectPath, generation)) return;
			this.applyRefreshError(projectPath, error);
			this.pruneCache();
		} finally {
			if (this.inFlightByProject.get(projectPath) === controller) {
				this.inFlightByProject.delete(projectPath);
			}
			if (this.isCurrentResponse(projectPath, generation)) {
				this.updateEntry(projectPath, { isRefreshing: false });
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
					this.now() - (this.entryFor(project.projectPath)?.lastUpdatedAt ?? 0) <
						QUICK_GIT_PROCESSING_POLL_MS
				) {
					continue;
				}
				void this.refreshFor(
					project.projectPath,
					reason === 'visibility'
						? reason
						: project.isProcessing
							? 'agent-processing-poll'
							: 'idle-poll',
				);
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
		const nextKey = this.isEnabled && this.visibleProjects.length > 0
			? JSON.stringify(this.visibleProjects)
			: '';
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
		for (const project of this.visibleProjects) this.#cancelProjectWork(project.projectPath);
		this.visibleProjects = [];
		this.entries = {};
	}

	private applyResponse(projectPath: string, result: GitQuickSummaryResponse): void {
		const now = this.now();
		if (result.status === 'ready') {
			this.updateEntry(projectPath, {
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
			this.updateEntry(projectPath, {
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

		this.applySummaryError(projectPath, result.message, now);
	}

	private isCurrentResponse(projectPath: string, generation: number): boolean {
		return (
			generation === this.requestGenerationByProject.get(projectPath) &&
			this.#hasVisibleProject(projectPath) &&
			this.isEnabled
		);
	}

	private applyRefreshError(projectPath: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.applySummaryError(projectPath, message, this.now());
	}

	private applySummaryError(projectPath: string, message: string, now: number): void {
		const existing = this.entryFor(projectPath);
		this.updateEntry(projectPath, {
			status: existing?.summary ? 'ready' : 'error',
			lastError: message,
			hasResponse: true,
			isRefreshing: false,
			lastAccessedAt: now,
			lastUpdatedAt: now,
		});
	}

	private entryFor(projectPath: string | null): GitQuickSummaryCacheEntry | null {
		if (!projectPath) return null;
		return this.entries[projectPath] ?? null;
	}

	private touchProject(projectPath: string): void {
		this.updateEntry(projectPath, { lastAccessedAt: this.now() });
	}

	private updateEntry(projectPath: string, patch: Partial<GitQuickSummaryCacheEntry>): void {
		const existing = this.entryFor(projectPath) ?? this.createEntry(projectPath);
		this.entries = {
			...this.entries,
			[projectPath]: {
				...existing,
				...patch,
				projectPath,
			},
		};
	}

	private createEntry(projectPath: string): GitQuickSummaryCacheEntry {
		const now = this.now();
		return {
			projectPath,
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
		const protectedPaths = new Set(this.visibleProjects.map((project) => project.projectPath));
		if (this.projectPath) protectedPaths.add(this.projectPath);
		const protectedEntries = [...protectedPaths].flatMap((projectPath) => {
			const entry = this.entryFor(projectPath);
			return entry ? [entry] : [];
		});
		const retained = Object.values(this.entries)
			.filter((entry) => {
				if (protectedPaths.has(entry.projectPath)) return false;
				return now - entry.lastAccessedAt <= QUICK_GIT_CACHE_MAX_AGE_MS;
			})
			.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);
		const bounded = [...protectedEntries, ...retained].slice(0, QUICK_GIT_CACHE_MAX_ENTRIES);

		this.entries = Object.fromEntries(
			bounded.map((entry) => [entry.projectPath, entry]),
		);
	}

	#hasVisibleProject(projectPath: string): boolean {
		return this.visibleProjects.some((project) => project.projectPath === projectPath);
	}

	#cancelProjectWork(projectPath: string): void {
		this.#clearProjectDebounce(projectPath);
		this.pendingRefreshByProject.delete(projectPath);
		this.requestGenerationByProject.set(
			projectPath,
			(this.requestGenerationByProject.get(projectPath) ?? 0) + 1,
		);
		this.inFlightByProject.get(projectPath)?.abort();
		this.inFlightByProject.delete(projectPath);
	}

	#clearProjectDebounce(projectPath: string): void {
		const timer = this.debounceTimerByProject.get(projectPath);
		if (timer === undefined) return;
		this.clearTimeoutFn(timer);
		this.debounceTimerByProject.delete(projectPath);
	}
}
