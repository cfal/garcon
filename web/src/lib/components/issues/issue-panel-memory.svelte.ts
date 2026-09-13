import type { IssueStatus, IssueSummary } from '$shared/issues';
import type { IssueDraftPartition } from '$lib/issues/drafts/issue-draft-recovery.js';
import type { IssueWindowKey } from '$lib/issues/catalog/issue-collection.js';
import { createRandomId } from '$lib/utils/random-id.js';

export type IssueFocusTarget =
	| { kind: 'issue'; issueId: string; control: 'open' | 'status' }
	| { kind: 'draft'; draftId: string; field: 'title' | 'description' | 'composer' }
	| { kind: 'comment'; issueId: string; commentId: string; control: 'editor' }
	| { kind: 'toolbar'; control: 'new' | 'back' | 'detail' }
	| { kind: 'lane'; status: IssueStatus };
export interface IssueFocusBookmark {
	readonly target: IssueFocusTarget;
	readonly selection?: {
		readonly start: number;
		readonly end: number;
		readonly direction: 'forward' | 'backward' | 'none';
		readonly version: string;
	};
}
export interface IssueStatusMove {
	readonly issueId: string;
	readonly bookmark: IssueFocusBookmark | null;
	readonly fallbackIndex: number;
	readonly partition: IssueDraftPartition;
}
export class IssuePanelMemory {
	readonly id = createRandomId();
	readonly scroll = new Map<string, number>();
	focus: IssueFocusBookmark | null = null;
	returnTo: IssueFocusBookmark | null = null;
	returnIndex = 0;
	restoreFocus = false;
	partition: IssueDraftPartition | null = null;
	pinned = $state.raw<{ key: IssueWindowKey; issue: IssueSummary } | null>(null);
	pendingStatusMove = $state.raw<IssueStatusMove | null>(null);
}
const memories = new WeakMap<object, IssuePanelMemory>();
export function issuePanelMemory(controller: object): IssuePanelMemory {
	let memory = memories.get(controller);
	if (!memory) {
		memory = new IssuePanelMemory();
		memories.set(controller, memory);
	}
	return memory;
}

export function captureIssueFocus(element: Element | null): IssueFocusBookmark | null {
	const control = element?.closest<HTMLElement>('[data-issue-focus]');
	if (!control?.dataset.issueFocus) return null;
	const target = JSON.parse(control.dataset.issueFocus) as IssueFocusTarget;
	const input =
		control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? control : null;
	const selection =
		input?.selectionStart !== null &&
		input?.selectionStart !== undefined &&
		input.selectionEnd !== null &&
		control.dataset.draftVersion !== undefined
			? {
					start: input.selectionStart,
					end: input.selectionEnd,
					direction: input.selectionDirection ?? 'none',
					version: control.dataset.draftVersion,
				}
			: undefined;
	return { target, ...(selection ? { selection } : {}) };
}

export function restoreIssueFocus(
	roots: readonly HTMLElement[],
	bookmark: IssueFocusBookmark | null,
	fallbackIndex = 0,
): void {
	const controls = roots
		.flatMap((root) => [...root.querySelectorAll<HTMLElement>('[data-issue-focus]')])
		.filter(
			(element) =>
				!element.closest('[hidden]') &&
				!element.hasAttribute('disabled') &&
				element.getClientRects().length > 0,
		);
	const match =
		bookmark &&
		controls.find((element) => element.dataset.issueFocus === JSON.stringify(bookmark.target));
	const rows = controls.filter((element) =>
		element.dataset.issueFocus?.includes('"control":"open"'),
	);
	const fallback =
		rows[Math.min(fallbackIndex, rows.length - 1)] ??
		controls.find((element) => element.dataset.issueFocus?.includes('"kind":"lane"')) ??
		controls.find((element) => element.dataset.issueFocus?.includes('"control":"new"'));
	const element = match || fallback;
	element?.focus({ preventScroll: true });
	if (
		match &&
		bookmark.selection &&
		(match instanceof HTMLInputElement || match instanceof HTMLTextAreaElement) &&
		match.dataset.draftVersion === bookmark.selection.version
	) {
		match.setSelectionRange(
			bookmark.selection.start,
			bookmark.selection.end,
			bookmark.selection.direction,
		);
	}
}
