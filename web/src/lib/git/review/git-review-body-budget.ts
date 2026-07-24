import type {
	GitReviewBodyPurpose,
	GitReviewDocumentLimits,
	GitReviewFileBody,
} from '$lib/api/git.js';

export interface GitReviewBodyBudgetDecision {
	accept: boolean;
	evictedPaths: string[];
	loadedRows: number;
	loadedBytes: number;
	reason?: 'collection-too-many-rows' | 'collection-too-many-bytes';
}

export function collectionLimitDecisionFromGitReviewBody(
	body: GitReviewFileBody,
	currentBodies: Readonly<Record<string, GitReviewFileBody>>,
): GitReviewBodyBudgetDecision | null {
	if (
		body.limitReason !== 'collection-too-many-rows' &&
		body.limitReason !== 'collection-too-many-bytes'
	) {
		return null;
	}
	return {
		accept: false,
		evictedPaths: [],
		...loadedGitReviewBodyTotals(currentBodies, body.path),
		reason: body.limitReason,
	};
}

export function decideGitReviewBodyBudget(
	body: GitReviewFileBody,
	purpose: GitReviewBodyPurpose,
	currentBodies: Readonly<Record<string, GitReviewFileBody>>,
	bodyPurposes: ReadonlyMap<string, GitReviewBodyPurpose>,
	limits: GitReviewDocumentLimits,
): GitReviewBodyBudgetDecision {
	if (body.bodyState !== 'loaded') {
		return { accept: true, evictedPaths: [], loadedRows: 0, loadedBytes: 0 };
	}
	const loaded = Object.entries(currentBodies).filter(
		([path, candidate]) => path !== body.path && candidate.bodyState === 'loaded',
	);
	let { loadedRows, loadedBytes } = loadedGitReviewBodyTotals(currentBodies, body.path);
	const evictedPaths: string[] = [];

	if (
		purpose === 'visible' &&
		(loadedRows + body.renderedRowCount > limits.maxLoadedRows ||
			loadedBytes + body.patchBytes > limits.maxLoadedPatchBytes)
	) {
		for (const [path, candidate] of loaded) {
			if (bodyPurposes.get(path) !== 'prefetch') continue;
			evictedPaths.push(path);
			loadedRows -= candidate.renderedRowCount;
			loadedBytes -= candidate.patchBytes;
			if (
				loadedRows + body.renderedRowCount <= limits.maxLoadedRows &&
				loadedBytes + body.patchBytes <= limits.maxLoadedPatchBytes
			) {
				break;
			}
		}
	}

	const rowsExceeded = loadedRows + body.renderedRowCount > limits.maxLoadedRows;
	const bytesExceeded = loadedBytes + body.patchBytes > limits.maxLoadedPatchBytes;
	return {
		accept: !rowsExceeded && !bytesExceeded,
		evictedPaths,
		loadedRows,
		loadedBytes,
		...(rowsExceeded
			? { reason: 'collection-too-many-rows' as const }
			: bytesExceeded
				? { reason: 'collection-too-many-bytes' as const }
				: {}),
	};
}

function loadedGitReviewBodyTotals(
	currentBodies: Readonly<Record<string, GitReviewFileBody>>,
	excludedPath: string,
): Pick<GitReviewBodyBudgetDecision, 'loadedRows' | 'loadedBytes'> {
	let loadedRows = 0;
	let loadedBytes = 0;
	for (const [path, body] of Object.entries(currentBodies)) {
		if (path === excludedPath || body.bodyState !== 'loaded') continue;
		loadedRows += body.renderedRowCount;
		loadedBytes += body.patchBytes;
	}
	return { loadedRows, loadedBytes };
}
