import type {
	ChatDraftAppend,
	ChatDraftAppendResult,
} from '$lib/chat/composer/chat-draft-append.js';
import {
	GitInlineCommentState,
	type CommentComposerState,
	type GitDiffSeverity,
} from '$lib/git/review/git-inline-comment.svelte.js';

export class GitReviewDrafts {
	readonly inlineComment = new GitInlineCommentState();

	get commentComposer(): CommentComposerState {
		return this.inlineComment.composer;
	}

	get commentFeedback() {
		return this.inlineComment.feedback;
	}

	get commentError(): string | null {
		return this.inlineComment.error;
	}

	get commentCopyText(): string | null {
		return this.inlineComment.copyText;
	}

	openCommentComposer(filePath: string, side: 'before' | 'after', line: number): void {
		this.inlineComment.open(filePath, side, line);
	}

	markCommentComposerFocused(): void {
		this.inlineComment.markFocused();
	}

	setCommentBody(body: string): void {
		this.inlineComment.setBody(body);
	}

	setCommentSeverity(severity: GitDiffSeverity): void {
		this.inlineComment.setSeverity(severity);
	}

	markContextChangeBlocked(): void {
		this.inlineComment.markContextChangeBlocked();
	}

	appendComment(append: ChatDraftAppend | undefined, block: string): ChatDraftAppendResult {
		return this.inlineComment.appendBlock(append, block);
	}

	closeCommentComposer(): void {
		this.inlineComment.close();
	}

	clearCommentFeedback(): void {
		this.inlineComment.clearFeedback();
	}

	reset(): void {
		this.inlineComment.reset();
	}
}
