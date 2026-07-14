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
	entries = $state<Record<string, GitQuickSummaryCacheEntry>>({});
	isEnabled = $state(true);
	isProcessing = $state(false);

	private requestGeneration = 0;
	private inFlight: AbortController | null = null;
	private pendingRefresh: GitQuickRefreshReason | null = null;
	private debounceTimer: QuickSummaryTimeoutHandle | null = null;
	private readonly getSummary: typeof getGitQuickSummary;
	private readonly setTimeoutFn: QuickSummarySetTimeout;
	private readonly clearTimeoutFn: QuickSummaryClearTimeout;
	private readonly now: QuickSummaryNow;

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
		const previousProjectPath = this.projectPath;
		this.clearDebounce();
		this.inFlight?.abort();
		this.requestGeneration += 1;
		if (previousProjectPath) this.updateEntry(previousProjectPath, { isRefreshing: false });
		this.projectPath = projectPath;
		if (projectPath && this.isEnabled) {
			this.touchProject(projectPath);
			this.pruneCache(projectPath);
			this.scheduleRefresh('project-change', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
		}
	}

	setEnabled(enabled: boolean): void {
		if (enabled === this.isEnabled) return;
		this.isEnabled = enabled;
		if (!enabled) {
			this.clearDebounce();
			this.inFlight?.abort();
			if (this.projectPath) this.updateEntry(this.projectPath, { isRefreshing: false });
			return;
		}
		if (this.projectPath) {
			this.touchProject(this.projectPath);
			this.pruneCache(this.projectPath);
			this.scheduleRefresh('tray-visible', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
		}
	}

	setProcessing(processing: boolean): void {
		if (processing === this.isProcessing) return;
		const wasProcessing = this.isProcessing;
		this.isProcessing = processing;
		if (wasProcessing && !processing) {
			this.scheduleRefresh('agent-stopped', QUICK_GIT_STOPPED_DEBOUNCE_MS);
		}
	}

	scheduleRefresh(reason: GitQuickRefreshReason, delayMs = 300): void {
		if (!this.projectPath || !this.isEnabled) return;
		this.pendingRefresh = reason;
		this.clearDebounce();
		this.debounceTimer = this.setTimeoutFn(() => {
			this.debounceTimer = null;
			void this.refresh(this.pendingRefresh ?? reason);
		}, delayMs);
	}

	async refresh(_reason: GitQuickRefreshReason): Promise<void> {
		const projectPath = this.projectPath;
		if (!projectPath || !this.isEnabled) return;
		this.clearDebounce();
		this.pendingRefresh = null;
		const generation = ++this.requestGeneration;
		this.inFlight?.abort();
		const controller = new AbortController();
		this.inFlight = controller;
		this.updateEntry(projectPath, { isRefreshing: true, lastAccessedAt: this.now() });

		try {
			const result = await this.getSummary(projectPath, { signal: controller.signal });
			if (!this.isCurrentResponse(projectPath, generation)) return;
			this.applyResponse(projectPath, result);
			this.pruneCache(projectPath);
		} catch (error) {
			if (isAbortError(error) || !this.isCurrentResponse(projectPath, generation)) return;
			this.applyRefreshError(projectPath, error);
			this.pruneCache(projectPath);
		} finally {
			if (this.inFlight === controller) this.inFlight = null;
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
		if (!this.projectPath || !this.isEnabled) return () => {};
		const intervalMs = this.isProcessing ? QUICK_GIT_PROCESSING_POLL_MS : QUICK_GIT_IDLE_POLL_MS;
		const intervalReason: GitQuickRefreshReason = this.isProcessing
			? 'agent-processing-poll'
			: 'idle-poll';
		const tick = (reason: GitQuickRefreshReason): void => {
			if (!this.projectPath || !this.isEnabled || !canPollCommitSummary(documentRef)) return;
			void this.refresh(reason);
		};
		const intervalId = setIntervalFn(() => tick(intervalReason), intervalMs);
		const handleVisibilityChange = (): void => {
			tick('visibility');
		};

		documentRef?.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			clearIntervalFn(intervalId);
			documentRef?.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}

	destroy(): void {
		this.clearDebounce();
		this.inFlight?.abort();
		this.inFlight = null;
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
		return generation === this.requestGeneration && this.projectPath === projectPath;
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

	private pruneCache(activeProjectPath: string | null = this.projectPath): void {
		const now = this.now();
		const activeEntry = activeProjectPath ? this.entryFor(activeProjectPath) : null;
		const retained = Object.values(this.entries)
			.filter((entry) => {
				if (entry.projectPath === activeProjectPath) return true;
				return now - entry.lastAccessedAt <= QUICK_GIT_CACHE_MAX_AGE_MS;
			})
			.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt);

		const bounded = retained.slice(0, QUICK_GIT_CACHE_MAX_ENTRIES);
		if (activeEntry && !bounded.some((entry) => entry.projectPath === activeEntry.projectPath)) {
			bounded.unshift(activeEntry);
		}

		this.entries = Object.fromEntries(
			bounded.slice(0, QUICK_GIT_CACHE_MAX_ENTRIES).map((entry) => [entry.projectPath, entry]),
		);
	}

	private clearDebounce(): void {
		if (!this.debounceTimer) return;
		this.clearTimeoutFn(this.debounceTimer);
		this.debounceTimer = null;
	}
}
