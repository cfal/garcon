import { describe, expect, it } from 'vitest';
import { GitReviewDrafts } from '../git/git-review-drafts.svelte';

describe('GitReviewDrafts', () => {
	it('preserves an in-progress draft when its row is activated again', () => {
		const drafts = new GitReviewDrafts();
		drafts.openCommentComposer('src/a.ts', 'after', 12);
		drafts.commentComposer = {
			...drafts.commentComposer,
			body: 'Keep this draft',
			severity: 'warning',
		};

		drafts.openCommentComposer('src/a.ts', 'after', 12);

		expect(drafts.commentComposer.body).toBe('Keep this draft');
		expect(drafts.commentComposer.severity).toBe('warning');
	});
});
