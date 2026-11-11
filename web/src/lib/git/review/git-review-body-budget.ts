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

export function gitReviewBodyBytes(body: GitReviewFileBody | undefined): number {
	if (!body) return 0;
	return (
		Math.max(body.patchBytes, (body.patch?.length ?? 0) * 2) +
		(body.patchIndex?.estimatedBytes ?? 0)
	);
}

export function decideGitReviewBodyBudget(
	body: GitReviewFileBody,
	purpose: GitReviewBodyPurpose,
	currentBodies: Readonly<Record<string, GitReviewFileBody>>,
	pinnedPaths: ReadonlySet<string>,
	limits: GitReviewDocumentLimits,
): GitReviewBodyBudgetDecision {
	if (body.bodyState !== 'loaded') {
		return { accept: true, evictedPaths: [], loadedRows: 0, loadedBytes: 0 };
	}
	const loaded = Object.entries(currentBodies).filter(
		([path, candidate]) => path !== body.path && candidate.bodyState === 'loaded',
	);
	let loadedRows = 0;
	let loadedBytes = 0;
	let loadedPatchBytes = 0;
	for (const [, candidate] of loaded) {
		loadedRows += candidate.renderedRowCount;
		loadedBytes += gitReviewBodyBytes(candidate);
		loadedPatchBytes += candidate.patchBytes;
	}
	const evictedPaths: string[] = [];
	const bodyBytes = gitReviewBodyBytes(body);

	if (
		purpose === 'visible' &&
		(loadedRows + body.renderedRowCount > limits.maxLoadedRows ||
			loadedBytes + bodyBytes > limits.maxLoadedPatchBytes)
	) {
		for (const [path, candidate] of loaded) {
			if (pinnedPaths.has(path)) continue;
			evictedPaths.push(path);
			loadedRows -= candidate.renderedRowCount;
			loadedBytes -= gitReviewBodyBytes(candidate);
			loadedPatchBytes -= candidate.patchBytes;
			if (
				loadedRows + body.renderedRowCount <= limits.maxLoadedRows &&
				loadedBytes + bodyBytes <= limits.maxLoadedPatchBytes
			) {
				break;
			}
		}
	}

	const rowsExceeded = loadedRows + body.renderedRowCount > limits.maxLoadedRows;
	// Visible admission uses the server's patch units; retained estimates constrain cold work.
	const bytesExceeded =
		(purpose === 'visible' ? loadedPatchBytes + body.patchBytes : loadedBytes + bodyBytes) >
		limits.maxLoadedPatchBytes;
	const decision: GitReviewBodyBudgetDecision = {
		accept: !rowsExceeded && !bytesExceeded,
		evictedPaths,
		loadedRows,
		loadedBytes,
	};
	if (rowsExceeded) {
		decision.reason = 'collection-too-many-rows';
	} else if (bytesExceeded) {
		decision.reason = 'collection-too-many-bytes';
	}
	return decision;
}
