import type {
	GitRenderedDiffRow,
	GitRenderedHunk,
	GitReviewFileBody,
	GitReviewFilePatchBody,
} from '$lib/api/git.js';
import { createGitPatchIndex, type GitPatchIndex } from './git-patch-index.js';

export function materializeRenderedRows(index: GitPatchIndex): GitRenderedDiffRow[] {
	return Array.from({ length: index.rowCount }, (_, rowIndex) => index.rowAt(rowIndex));
}

export function materializeRenderedHunks(index: GitPatchIndex): GitRenderedHunk[] {
	return Array.from({ length: index.hunkCount }, (_, hunkIndex) => index.hunkAt(hunkIndex));
}

export function materializeLegacyReviewBody(body: GitReviewFilePatchBody): GitReviewFileBody {
	if (body.bodyState !== 'loaded' || body.patch === null) {
		return {
			...body,
			rows: [],
			hunks: [],
		};
	}
	const index = createGitPatchIndex(body.patch, body.renderedRowCount);
	return {
		...body,
		rows: materializeRenderedRows(index),
		hunks: materializeRenderedHunks(index),
	};
}
