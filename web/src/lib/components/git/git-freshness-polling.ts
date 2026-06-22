import { GIT_FRESHNESS_POLL_MS } from '$lib/api/git.js';

interface FreshnessPollingDocument {
	visibilityState: DocumentVisibilityState;
	addEventListener: Document['addEventListener'];
	removeEventListener: Document['removeEventListener'];
}

interface GitFreshnessPollingOptions {
	projectPath: string;
	checkFreshness: (projectPath: string) => void;
	documentRef?: FreshnessPollingDocument;
	intervalMs?: number;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

export function canPollGitFreshness(
	documentRef: Pick<FreshnessPollingDocument, 'visibilityState'> | undefined = globalThis.document,
): boolean {
	return !documentRef || documentRef.visibilityState === 'visible';
}

export function startGitFreshnessPolling({
	projectPath,
	checkFreshness,
	documentRef = globalThis.document,
	intervalMs = GIT_FRESHNESS_POLL_MS,
	setIntervalFn = globalThis.setInterval,
	clearIntervalFn = globalThis.clearInterval,
}: GitFreshnessPollingOptions): () => void {
	function tick(): void {
		if (!canPollGitFreshness(documentRef)) return;
		checkFreshness(projectPath);
	}

	const intervalId = setIntervalFn(tick, intervalMs);

	function handleVisibilityChange(): void {
		tick();
	}

	documentRef?.addEventListener('visibilitychange', handleVisibilityChange);

	return () => {
		clearIntervalFn(intervalId);
		documentRef?.removeEventListener('visibilitychange', handleVisibilityChange);
	};
}
