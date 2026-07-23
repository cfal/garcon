import type { GitDiffTab } from '$lib/api/git.js';
import type {
	CommentComposerState,
	GitDiffSeverity,
} from '$lib/git/review/git-inline-comment.svelte.js';
import type { GitDiffActionTarget } from '$lib/git/workbench/git-workbench-types.js';

export interface GitDiffCommentInteraction {
	composerState: CommentComposerState;
	commentFeedback: {
		filePath: string;
		side: 'before' | 'after';
		line: number;
		message: string;
	} | null;
	commentError: string | null;
	commentCopyText: string | null;
	onAddComment: (filePath: string, side: 'before' | 'after', line: number) => void;
	onComposerBodyChange?: (body: string) => void;
	onComposerSeverityChange?: (severity: GitDiffSeverity) => void;
	onComposerSubmit?: () => void;
	onComposerClose?: () => void;
	onComposerFocusHandled?: () => void;
	onOpenChat: () => void;
}

export interface GitDiffWorkbenchInteraction extends GitDiffCommentInteraction {
	kind: 'workbench';
	showInlineCommentComposer: boolean;
	activeTab: GitDiffTab;
	selectedLineKeys: Set<string>;
	operationPending: boolean;
	onToggleLineSelection: (key: string) => void;
	onSelectLineRange: (startKey: string, endKey: string, allKeys: string[]) => void;
	onStageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
	onUnstageHunk: (target: GitDiffActionTarget, hunkIndex: number) => void;
	onStageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
	onUnstageLine: (target: GitDiffActionTarget, diffLineIndex: number) => void;
}

export interface GitDiffCommentableInteraction extends GitDiffCommentInteraction {
	kind: 'commentable';
}

export interface GitDiffReadOnlyInteraction {
	kind: 'read-only';
}

export type GitDiffRowInteraction =
	GitDiffWorkbenchInteraction | GitDiffCommentableInteraction | GitDiffReadOnlyInteraction;
