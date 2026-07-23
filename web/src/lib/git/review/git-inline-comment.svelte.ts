import type {
	ChatDraftAppend,
	ChatDraftAppendResult,
} from '$lib/chat/composer/chat-draft-append.js';
import * as m from '$lib/paraglide/messages.js';

export type GitDiffSide = 'before' | 'after';
export type GitDiffSeverity = 'note' | 'warning' | 'blocker';

export interface CommentComposerState {
	open: boolean;
	focusPending: boolean;
	filePath: string;
	side: GitDiffSide;
	line: number;
	body: string;
	severity: GitDiffSeverity;
}

export interface GitInlineCommentFeedback {
	filePath: string;
	side: GitDiffSide;
	line: number;
	message: string;
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

export class GitInlineCommentState {
	composer = $state<CommentComposerState>({ ...CLOSED_COMPOSER });
	feedback = $state<GitInlineCommentFeedback | null>(null);
	error = $state<string | null>(null);
	copyText = $state<string | null>(null);
	private feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

	get canSubmit(): boolean {
		return this.composer.open && Boolean(this.composer.body.trim());
	}

	open(filePath: string, side: GitDiffSide, line: number): void {
		if (
			this.composer.open &&
			this.composer.filePath === filePath &&
			this.composer.side === side &&
			this.composer.line === line
		) {
			return;
		}
		this.composer = {
			open: true,
			focusPending: true,
			filePath,
			side,
			line,
			body: '',
			severity: 'note',
		};
		this.clearError();
	}

	markFocused(): void {
		if (!this.composer.open || !this.composer.focusPending) return;
		this.composer.focusPending = false;
	}

	setBody(body: string): void {
		if (!this.composer.open) return;
		this.composer.body = body;
		this.clearError();
	}

	setSeverity(severity: GitDiffSeverity): void {
		if (!this.composer.open) return;
		this.composer.severity = severity;
		this.clearError();
	}

	markContextChangeBlocked(): void {
		if (!this.composer.open) return;
		this.error = m.git_comment_finish_before_context_change();
		this.copyText = null;
	}

	appendBlock(append: ChatDraftAppend | undefined, block: string): ChatDraftAppendResult {
		if (!this.canSubmit) return 'unavailable';
		if (!append) return this.markUnavailable(block);
		const composer = this.composer;
		const result = append(block);
		if (result === 'unavailable') return this.markUnavailable(block);
		this.feedback = {
			filePath: composer.filePath,
			side: composer.side,
			line: composer.line,
			message:
				result === 'duplicate' ? m.git_comment_already_in_chat() : m.git_comment_added_to_chat(),
		};
		this.close();
		if (this.feedbackTimeout) clearTimeout(this.feedbackTimeout);
		this.feedbackTimeout = setTimeout(() => this.clearFeedback(), 4000);
		return result;
	}

	close(): void {
		this.composer = { ...CLOSED_COMPOSER };
		this.clearError();
	}

	clearFeedback(): void {
		if (this.feedbackTimeout) clearTimeout(this.feedbackTimeout);
		this.feedbackTimeout = null;
		this.feedback = null;
	}

	reset(): void {
		this.close();
		this.clearFeedback();
	}

	private markUnavailable(block: string): ChatDraftAppendResult {
		this.error = m.git_comment_chat_required();
		this.copyText = block;
		return 'unavailable';
	}

	private clearError(): void {
		this.error = null;
		this.copyText = null;
	}
}
