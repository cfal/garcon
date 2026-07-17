import { GIT_FRESHNESS_POLL_MS } from '$lib/api/git.js';
import {
	canPollVisibility,
	startVisibilityPolling,
} from '$lib/components/shared/visibility-polling.js';

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
	return canPollVisibility(documentRef);
}

export function startGitFreshnessPolling({
	projectPath,
	checkFreshness,
	documentRef = globalThis.document,
	intervalMs = GIT_FRESHNESS_POLL_MS,
	setIntervalFn = globalThis.setInterval,
	clearIntervalFn = globalThis.clearInterval,
}: GitFreshnessPollingOptions): () => void {
	return startVisibilityPolling({
		intervalMs,
		poll: () => checkFreshness(projectPath),
		documentRef,
		setIntervalFn,
		clearIntervalFn,
	});
}
