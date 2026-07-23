import type { GitReviewCommentDraft } from '$lib/api/git.js';
import type {
	ChatDraftAppend,
	ChatDraftAppendResult,
} from '$lib/chat/composer/chat-draft-append.js';
import * as m from '$lib/paraglide/messages.js';

export interface CommentComposerState {
	open: boolean;
	focusPending: boolean;
	filePath: string;
	side: 'before' | 'after';
	line: number;
	body: string;
	severity: 'note' | 'warning' | 'blocker';
}

const CLOSED_COMPOSER: CommentComposerState = {
	open: false,
	focusPending: false,
	filePath: '',
	side: 'after',
	line: 0,
	body: '',
	severity: 'note',
};

export class GitReviewDrafts {
	reviewComments = $state<GitReviewCommentDraft[]>([]);
	reviewSummary = $state('');
	reviewModalOpen = $state(false);
	commentComposer = $state<CommentComposerState>({ ...CLOSED_COMPOSER });
	commentFeedback = $state<{
		filePath: string;
		side: 'before' | 'after';
		line: number;
		message: string;
	} | null>(null);
	commentError = $state<string | null>(null);
	commentCopyText = $state<string | null>(null);
	private feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

	get commentsByFile(): Record<string, GitReviewCommentDraft[]> {
		const grouped: Record<string, GitReviewCommentDraft[]> = {};
		for (const comment of this.reviewComments) {
			if (!grouped[comment.filePath]) grouped[comment.filePath] = [];
			grouped[comment.filePath].push(comment);
		}
		return grouped;
	}

	commentsForFile(filePath: string): GitReviewCommentDraft[] {
		return this.reviewComments.filter((comment) => comment.filePath === filePath);
	}

	openCommentComposer(filePath: string, side: 'before' | 'after', line: number): void {
		if (
			this.commentComposer.open &&
			this.commentComposer.filePath === filePath &&
			this.commentComposer.side === side &&
			this.commentComposer.line === line
		) {
			return;
		}
		this.commentComposer = {
			open: true,
			focusPending: true,
			filePath,
			side,
			line,
			body: '',
			severity: 'note',
		};
		this.clearCommentError();
	}

	markCommentComposerFocused(): void {
		if (!this.commentComposer.open || !this.commentComposer.focusPending) return;
		this.commentComposer.focusPending = false;
	}

	setCommentBody(body: string): void {
		if (!this.commentComposer.open) return;
		this.commentComposer.body = body;
		this.clearCommentError();
	}

	setCommentSeverity(severity: GitReviewCommentDraft['severity']): void {
		if (!this.commentComposer.open) return;
		this.commentComposer.severity = severity;
		this.clearCommentError();
	}

	commitCommentComposer(): void {
		const composer = this.commentComposer;
		if (!composer.open || !composer.body.trim()) return;
		this.addDraftComment({
			filePath: composer.filePath,
			side: composer.side,
			line: composer.line,
			body: composer.body.trim(),
			severity: composer.severity,
		});
		this.closeCommentComposer();
	}

	addDraftComment(input: Omit<GitReviewCommentDraft, 'id' | 'createdAt'>): void {
		const comment: GitReviewCommentDraft = {
			...input,
			id: `comment-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
			createdAt: new Date().toISOString(),
		};
		this.reviewComments = [...this.reviewComments, comment];
	}

	updateDraftComment(id: string, patch: Partial<GitReviewCommentDraft>): void {
		this.reviewComments = this.reviewComments.map((comment) =>
			comment.id === id ? { ...comment, ...patch } : comment,
		);
	}

	removeDraftComment(id: string): void {
		this.reviewComments = this.reviewComments.filter((comment) => comment.id !== id);
	}

	buildFinalizedReviewMessage(): string {
		const lines: string[] = ['Git review draft for current workspace:', ''];
		if (this.reviewSummary.trim()) lines.push('Summary:', this.reviewSummary.trim(), '');
		if (this.reviewComments.length > 0) {
			lines.push('Comments:');
			for (const comment of this.reviewComments) {
				const range = comment.lineEnd ? `${comment.line}-${comment.lineEnd}` : `${comment.line}`;
				lines.push(`- [${comment.severity}] ${comment.filePath}:${range} (${comment.side})`);
				lines.push(`  ${comment.body}`);
			}
		}
		return lines.join('\n');
	}

	async finalizeReviewToAgent(send: (message: string) => Promise<boolean>): Promise<boolean> {
		if (this.reviewComments.length === 0 && !this.reviewSummary.trim()) return false;
		const sent = await send(this.buildFinalizedReviewMessage());
		if (sent) {
			this.reviewComments = [];
			this.reviewSummary = '';
		}
		return sent;
	}

	appendComment(append: ChatDraftAppend | undefined, block: string): ChatDraftAppendResult {
		if (!append) {
			this.commentError = m.git_comment_chat_required();
			this.commentCopyText = block;
			return 'unavailable';
		}
		const composer = this.commentComposer;
		const result = append(block);
		if (result === 'unavailable') {
			this.commentError = m.git_comment_chat_required();
			this.commentCopyText = block;
			return result;
		}
		this.commentFeedback = {
			filePath: composer.filePath,
			side: composer.side,
			line: composer.line,
			message:
				result === 'duplicate' ? m.git_comment_already_in_chat() : m.git_comment_added_to_chat(),
		};
		this.closeCommentComposer();
		if (this.feedbackTimeout) clearTimeout(this.feedbackTimeout);
		this.feedbackTimeout = setTimeout(() => this.clearCommentFeedback(), 4000);
		return result;
	}

	closeCommentComposer(): void {
		this.commentComposer = { ...CLOSED_COMPOSER };
		this.clearCommentError();
	}

	clearCommentFeedback(): void {
		if (this.feedbackTimeout) clearTimeout(this.feedbackTimeout);
		this.feedbackTimeout = null;
		this.commentFeedback = null;
	}

	reset(): void {
		this.reviewComments = [];
		this.reviewSummary = '';
		this.reviewModalOpen = false;
		this.closeCommentComposer();
		this.clearCommentFeedback();
	}

	private clearCommentError(): void {
		this.commentError = null;
		this.commentCopyText = null;
	}
}
