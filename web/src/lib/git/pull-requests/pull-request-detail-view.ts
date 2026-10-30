// Projects the independent pull request reads onto what a detail tab can show.
// Content that is already shown stays visible through a failed refresh, with
// the failure beside it; nothing reports success for a part that did not load.

import type {
	PullRequestCheck,
	PullRequestDiff,
	PullRequestThread,
} from '$lib/api/pull-requests.js';
import type { PullRequestStatus } from '$shared/gh';

interface ReadView<T> {
	readonly value: T | null;
	readonly isLoading: boolean;
	readonly error: string | null;
}

export type PullRequestPartView<T> =
	| { readonly kind: 'ready'; readonly value: T; readonly refreshError: string | null }
	| { readonly kind: 'loading' }
	| { readonly kind: 'failed'; readonly error: string };

export interface PullRequestChanges {
	readonly diff: PullRequestDiff;
	readonly threads: readonly PullRequestThread[];
}

export function pullRequestChecksView(
	status: ReadView<PullRequestStatus>,
): PullRequestPartView<readonly PullRequestCheck[]> {
	if (status.value)
		return { kind: 'ready', value: status.value.checks, refreshError: status.error };
	if (status.error && !status.isLoading) return { kind: 'failed', error: status.error };
	return { kind: 'loading' };
}

export function pullRequestChangesView(
	status: ReadView<PullRequestStatus>,
	diff: ReadView<PullRequestDiff>,
	threads: ReadView<readonly PullRequestThread[]>,
): PullRequestPartView<PullRequestChanges> {
	if (diff.value) {
		return {
			kind: 'ready',
			value: { diff: diff.value, threads: threads.value ?? [] },
			refreshError: diff.error ?? status.error ?? threads.error,
		};
	}
	if (diff.isLoading || status.isLoading) return { kind: 'loading' };
	const error = diff.error ?? status.error;
	return error ? { kind: 'failed', error } : { kind: 'loading' };
}
