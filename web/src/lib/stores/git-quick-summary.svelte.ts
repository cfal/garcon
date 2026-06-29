import {
	getGitQuickSummary,
	type GitQuickSummaryReady,
	type GitQuickSummaryResponse,
} from '$lib/api/git.js';

export const QUICK_GIT_IDLE_POLL_MS = 15_000;
export const QUICK_GIT_PROCESSING_POLL_MS = 90_000;
export const QUICK_GIT_STOPPED_DEBOUNCE_MS = 500;
export const QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS = 100;

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
}

interface QuickSummaryPollingOptions {
	documentRef?: QuickSummaryDocument;
	setIntervalFn?: QuickSummarySetInterval;
	clearIntervalFn?: QuickSummaryClearInterval;
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name?: unknown }).name === 'AbortError'
	);
}

function canPollQuickGitSummary(
	documentRef: Pick<QuickSummaryDocument, 'visibilityState'> | undefined = globalThis.document,
): boolean {
	return !documentRef || documentRef.visibilityState === 'visible';
}

export class GitQuickSummaryStore {
	projectPath = $state<string | null>(null);
	summary = $state<GitQuickSummaryReady | null>(null);
	lastNonRepoProject = $state<string | null>(null);
	isLoading = $state(false);
	lastError = $state<string | null>(null);
	hasReadyResponseForCurrentProject = $state(false);
	isEnabled = $state(true);
	isProcessing = $state(false);

	private requestGeneration = 0;
	private inFlight: AbortController | null = null;
	private pendingRefresh: GitQuickRefreshReason | null = null;
	private debounceTimer: QuickSummaryTimeoutHandle | null = null;
	private readonly getSummary: typeof getGitQuickSummary;
	private readonly setTimeoutFn: QuickSummarySetTimeout;
	private readonly clearTimeoutFn: QuickSummaryClearTimeout;

	constructor(deps: GitQuickSummaryStoreDeps = {}) {
		this.getSummary = deps.getSummary ?? getGitQuickSummary;
		this.setTimeoutFn = deps.setTimeoutFn ?? setGlobalTimeout;
		this.clearTimeoutFn = deps.clearTimeoutFn ?? clearGlobalTimeout;
	}

	get canShowTray(): boolean {
		return this.canShowTrayFor(this.projectPath);
	}

	canShowTrayFor(projectPath: string | null): boolean {
		return Boolean(
			this.isEnabled &&
				projectPath &&
				this.lastNonRepoProject !== projectPath &&
				(this.projectPath !== projectPath || this.summary || !this.hasReadyResponseForCurrentProject),
		);
	}

	get hasChanges(): boolean {
		return Boolean(this.summary && this.summary.changedFiles > 0);
	}

	setProject(projectPath: string | null): void {
		if (projectPath === this.projectPath) return;
		this.clearDebounce();
		this.inFlight?.abort();
		this.requestGeneration += 1;
		this.projectPath = projectPath;
		this.summary = null;
		this.lastNonRepoProject = null;
		this.lastError = null;
		this.hasReadyResponseForCurrentProject = false;
		this.isLoading = false;
		if (projectPath && this.isEnabled) {
			this.scheduleRefresh('project-change', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
		}
	}

	setEnabled(enabled: boolean): void {
		if (enabled === this.isEnabled) return;
		this.isEnabled = enabled;
		if (!enabled) {
			this.clearDebounce();
			this.inFlight?.abort();
			this.isLoading = false;
			return;
		}
		if (this.projectPath) this.scheduleRefresh('tray-visible', QUICK_GIT_PROJECT_CHANGE_DEBOUNCE_MS);
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
		this.isLoading = true;

		try {
			const result = await this.getSummary(projectPath, { signal: controller.signal });
			if (!this.isCurrentResponse(projectPath, generation)) return;
			this.applyResponse(projectPath, result);
		} catch (error) {
			if (isAbortError(error) || !this.isCurrentResponse(projectPath, generation)) return;
			this.lastError = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.inFlight === controller) this.inFlight = null;
			if (this.isCurrentResponse(projectPath, generation)) this.isLoading = false;
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
			if (!this.projectPath || !this.isEnabled || !canPollQuickGitSummary(documentRef)) return;
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
	}

	private applyResponse(projectPath: string, result: GitQuickSummaryResponse): void {
		if (result.status === 'ready') {
			this.summary = result;
			this.lastNonRepoProject = null;
			this.hasReadyResponseForCurrentProject = true;
			this.lastError = null;
			return;
		}

		if (result.status === 'not-git-repository') {
			this.summary = null;
			this.lastNonRepoProject = projectPath;
			this.hasReadyResponseForCurrentProject = false;
			this.lastError = null;
			return;
		}

		this.lastError = result.message;
	}

	private isCurrentResponse(projectPath: string, generation: number): boolean {
		return generation === this.requestGeneration && this.projectPath === projectPath;
	}

	private clearDebounce(): void {
		if (!this.debounceTimer) return;
		this.clearTimeoutFn(this.debounceTimer);
		this.debounceTimer = null;
	}
}
