// Keeps recently shown pull request diffs so reselecting a pull request at the
// same commits neither transfers nor re-indexes its diff again. A diff is a
// pure function of its repository and commit pair; the executor is part of the
// key because each executor reads GitHub with its own login. The owning store
// only consults the cache after a fresh status read from that executor has
// confirmed the pair, so a cached diff is never shown without current access.

import { BoundedLruCache } from '$shared/bounded-lru-cache';
import type { PullRequestCommits } from '$shared/gh';
import type { PullRequestDiff, PullRequestTarget } from '$lib/api/pull-requests.js';

export const PULL_REQUEST_DIFF_CACHE_MAX_ENTRIES = 8;
export const PULL_REQUEST_DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const FILE_OVERHEAD_BYTES = 1024;
// Patch text is UTF-16, and its row index is built lazily at about the same size.
const PATCH_RETAINED_BYTES_PER_CHAR = 4;

export function pullRequestDiffKey(
	target: PullRequestTarget,
	number: number,
	commits: PullRequestCommits,
): string {
	return JSON.stringify([
		target.executorId,
		target.repository.host.toLowerCase(),
		target.repository.nameWithOwner.toLowerCase(),
		number,
		commits.baseRefOid,
		commits.headRefOid,
	]);
}

function estimateBytes(diff: PullRequestDiff): number {
	let bytes = diff.files.length * FILE_OVERHEAD_BYTES;
	for (const body of Object.values(diff.fileBodies)) {
		bytes += (body.patch?.length ?? 0) * PATCH_RETAINED_BYTES_PER_CHAR + FILE_OVERHEAD_BYTES;
	}
	return bytes;
}

export function createPullRequestDiffCache(): BoundedLruCache<string, PullRequestDiff> {
	return new BoundedLruCache({
		maxEntries: PULL_REQUEST_DIFF_CACHE_MAX_ENTRIES,
		maxBytes: PULL_REQUEST_DIFF_CACHE_MAX_BYTES,
		sizeOf: estimateBytes,
	});
}
