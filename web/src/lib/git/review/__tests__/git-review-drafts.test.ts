import { describe, expect, it } from 'vitest';
import { GitReviewDrafts } from '$lib/git/review/git-review-drafts.svelte.js';

describe('GitReviewDrafts', () => {
	it('preserves an in-progress draft when its row is activated again', () => {
		const drafts = new GitReviewDrafts();
		drafts.openCommentComposer('src/a.ts', 'after', 12);
		drafts.setCommentBody('Keep this draft');
		drafts.setCommentSeverity('warning');

		drafts.openCommentComposer('src/a.ts', 'after', 12);

		expect(drafts.commentComposer.body).toBe('Keep this draft');
		expect(drafts.commentComposer.severity).toBe('warning');
	});

	it('preserves the draft and exposes the formatted block when Chat is unavailable', () => {
		const drafts = new GitReviewDrafts();
		drafts.openCommentComposer('src/a.ts', 'after', 12);
		drafts.setCommentBody('Keep this comment');

		const result = drafts.appendComment(undefined, 'formatted block');

		expect(result).toBe('unavailable');
		expect(drafts.commentComposer.body).toBe('Keep this comment');
		expect(drafts.commentCopyText).toBe('formatted block');
	});

	it('does not report a Chat error when an empty composer is submitted', () => {
		const drafts = new GitReviewDrafts();
		drafts.openCommentComposer('src/a.ts', 'after', 12);

		expect(drafts.appendComment(undefined, 'unused block')).toBe('unavailable');
		expect(drafts.commentError).toBeNull();
		expect(drafts.commentCopyText).toBeNull();
	});

	it('keeps an open Changes comment when a context change is blocked', () => {
		const drafts = new GitReviewDrafts();
		drafts.openCommentComposer('src/a.ts', 'after', 12);
		drafts.setCommentBody('Keep this draft');

		drafts.markContextChangeBlocked();

		expect(drafts.commentComposer).toMatchObject({ open: true, body: 'Keep this draft' });
		expect(drafts.commentError).toBe('Add or close this comment before changing context lines.');
	});
});
