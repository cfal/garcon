import { apiDelete, apiGet, apiPost, apiPut } from './client.js';
import {
	isPullRequestReviewsSnapshot,
	type PullRequestReviewMutationResponse,
	type PullRequestReviewRepositoryInput,
	type PullRequestReviewRun,
	type PullRequestReviewRunDetail,
	type PullRequestReviewRunsResponse,
	type PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';

const BASE = '/api/v1/pull-request-reviews';

function snapshotFrom(value: unknown): PullRequestReviewsSnapshot {
	const snapshot = (value as { snapshot?: unknown } | null)?.snapshot ?? value;
	if (!isPullRequestReviewsSnapshot(snapshot)) throw new Error('Invalid pull request review response');
	return snapshot;
}

export async function getPullRequestReviews(): Promise<PullRequestReviewsSnapshot> {
	return snapshotFrom(await apiGet<unknown>(BASE));
}

export async function connectPullRequestReviewRepository(
	repository: PullRequestReviewRepositoryInput,
): Promise<PullRequestReviewsSnapshot> {
	// Resolving the repository runs `gh` on the executor, which can take longer than a plain save.
	return snapshotFrom(
		await apiPost<PullRequestReviewMutationResponse>(`${BASE}/repositories`, repository, {
			timeoutMs: 75_000,
		}),
	);
}

export async function updatePullRequestReviewRepository(
	id: string,
	repository: PullRequestReviewRepositoryInput,
): Promise<PullRequestReviewsSnapshot> {
	return snapshotFrom(
		await apiPut<PullRequestReviewMutationResponse>(
			`${BASE}/repositories`,
			{ id, repository },
			{ timeoutMs: 75_000 },
		),
	);
}

export async function removePullRequestReviewRepository(
	id: string,
): Promise<PullRequestReviewsSnapshot> {
	return snapshotFrom(
		await apiDelete<PullRequestReviewMutationResponse>(`${BASE}/repositories`, { id }),
	);
}

export async function scanPullRequestReviewRepositories(repositoryId?: string): Promise<void> {
	await apiPost(`${BASE}/scan`, repositoryId ? { repositoryId } : {});
}

export async function getPullRequestReviewRuns(
	repositoryId: string,
	number: number,
	options?: { signal?: AbortSignal },
): Promise<PullRequestReviewRunDetail[]> {
	const query = new URLSearchParams({ repositoryId, number: String(number) });
	const result = await apiGet<PullRequestReviewRunsResponse>(`${BASE}/runs?${query}`, options);
	if (!Array.isArray(result?.runs)) throw new Error('Invalid pull request review runs response');
	return result.runs;
}

export async function requestPullRequestReview(
	repositoryId: string,
	number: number,
): Promise<PullRequestReviewsSnapshot> {
	return snapshotFrom(await apiPost(`${BASE}/runs`, { repositoryId, number }));
}

export async function stopPullRequestReview(runId: string): Promise<PullRequestReviewsSnapshot> {
	return snapshotFrom(await apiPost(`${BASE}/runs/stop`, { runId }));
}

export async function postPullRequestReview(runId: string): Promise<PullRequestReviewsSnapshot> {
	// Posting re-reads the pull request on the executor before it comments.
	return snapshotFrom(
		await apiPost<PullRequestReviewMutationResponse & { run: PullRequestReviewRun }>(
			`${BASE}/runs/post`,
			{ runId },
			{ timeoutMs: 75_000 },
		),
	);
}
