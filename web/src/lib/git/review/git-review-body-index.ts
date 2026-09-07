import type {
	GitReviewFileBody,
	GitReviewFilePatchBody,
} from '$lib/api/git.js';
import { createGitPatchIndex } from './git-patch-index.js';
import {
	finishGitReviewPerformanceSpan,
	startGitReviewPerformanceSpan,
} from './git-review-performance.js';

export function createIndexedGitReviewFileBody(body: GitReviewFilePatchBody): GitReviewFileBody {
	if (body.bodyState !== 'loaded' || body.patch === null) {
		return {
			...body,
			patchIndex: null,
		};
	}
	let index: GitReviewFileBody['patchIndex'] | undefined;
	return {
		...body,
		get patchIndex() {
			if (!index) {
				const span = startGitReviewPerformanceSpan('patch-index');
				try {
					index = createGitPatchIndex(body.patch!, body.renderedRowCount);
				} finally {
					finishGitReviewPerformanceSpan(span);
				}
			}
			return index;
		},
	};
}
