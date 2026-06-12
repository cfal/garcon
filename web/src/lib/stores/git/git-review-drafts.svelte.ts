import type { GitReviewCommentDraft } from '$lib/api/git.js';

export interface CommentComposerState {
	open: boolean;
	filePath: string;
	side: 'before' | 'after';
	line: number;
	body: string;
	severity: 'note' | 'warning' | 'blocker';
}

const CLOSED_COMPOSER: CommentComposerState = {
	open: false,
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
		this.commentComposer = { open: true, filePath, side, line, body: '', severity: 'note' };
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

	closeCommentComposer(): void {
		this.commentComposer = { ...CLOSED_COMPOSER };
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

		if (this.reviewSummary.trim()) {
			lines.push('Summary:', this.reviewSummary.trim(), '');
		}

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
		if (this.reviewComments.length === 0 && !this.reviewSummary.trim()) {
			return false;
		}
		const message = this.buildFinalizedReviewMessage();
		const sent = await send(message);
		if (sent) {
			this.reviewComments = [];
			this.reviewSummary = '';
		}
		return sent;
	}

	reset(): void {
		this.reviewComments = [];
		this.reviewSummary = '';
		this.reviewModalOpen = false;
		this.commentComposer = { ...CLOSED_COMPOSER };
	}
}
