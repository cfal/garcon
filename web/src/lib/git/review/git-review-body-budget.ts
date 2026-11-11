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
	let { loadedRows, loadedBytes } = loadedGitReviewBodyTotals(currentBodies, body.path);
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
			if (
				loadedRows + body.renderedRowCount <= limits.maxLoadedRows &&
				loadedBytes + bodyBytes <= limits.maxLoadedPatchBytes
			) {
				break;
			}
		}
	}

	const rowsExceeded = loadedRows + body.renderedRowCount > limits.maxLoadedRows;
	// A server-admitted file remains inspectable when its text and indexes exceed the collection budget.
	const standaloneVisible =
		purpose === 'visible' &&
		loaded.length === evictedPaths.length &&
		body.patchBytes <= limits.maxFilePatchBytes &&
		body.renderedRowCount <= limits.maxFileRows;
	const bytesExceeded = !standaloneVisible && loadedBytes + bodyBytes > limits.maxLoadedPatchBytes;
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
		loadedBytes += gitReviewBodyBytes(body);
	}
	return { loadedRows, loadedBytes };
}
