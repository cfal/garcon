import type { TicketStatus, TicketSummary } from '$shared/tickets';
import type { TicketDraftPartition } from '$lib/tickets/drafts/ticket-draft-recovery.js';
import type { TicketWindowKey } from '$lib/tickets/catalog/ticket-collection.js';
import { createRandomId } from '$lib/utils/random-id.js';

export type TicketFocusTarget =
	| { kind: 'ticket'; ticketId: string; control: 'open' | 'status' }
	| { kind: 'draft'; draftId: string; field: 'title' | 'description' | 'composer' }
	| { kind: 'comment'; ticketId: string; commentId: string; control: 'editor' }
	| { kind: 'toolbar'; control: 'new' | 'back' | 'detail' }
	| { kind: 'lane'; status: TicketStatus };
export interface TicketFocusBookmark {
	readonly target: TicketFocusTarget;
	readonly selection?: {
		readonly start: number;
		readonly end: number;
		readonly direction: 'forward' | 'backward' | 'none';
		readonly version: string;
	};
}
export interface TicketStatusMove {
	readonly ticketId: string;
	readonly bookmark: TicketFocusBookmark | null;
	readonly fallbackIndex: number;
	readonly partition: TicketDraftPartition;
}
export class TicketPanelMemory {
	readonly id = createRandomId();
	readonly scroll = new Map<string, number>();
	focus: TicketFocusBookmark | null = null;
	returnTo: TicketFocusBookmark | null = null;
	returnIndex = 0;
	restoreFocus = false;
	partition: TicketDraftPartition | null = null;
	pinned = $state.raw<{ key: TicketWindowKey; ticket: TicketSummary } | null>(null);
	pendingStatusMove = $state.raw<TicketStatusMove | null>(null);
}
const memories = new WeakMap<object, TicketPanelMemory>();
export function ticketPanelMemory(controller: object): TicketPanelMemory {
	let memory = memories.get(controller);
	if (!memory) {
		memory = new TicketPanelMemory();
		memories.set(controller, memory);
	}
	return memory;
}

export function captureTicketFocus(element: Element | null): TicketFocusBookmark | null {
	const control = element?.closest<HTMLElement>('[data-ticket-focus]');
	if (!control?.dataset.ticketFocus) return null;
	const target = JSON.parse(control.dataset.ticketFocus) as TicketFocusTarget;
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

export function restoreTicketFocus(
	roots: readonly HTMLElement[],
	bookmark: TicketFocusBookmark | null,
	fallbackIndex = 0,
): void {
	const controls = roots
		.flatMap((root) => [...root.querySelectorAll<HTMLElement>('[data-ticket-focus]')])
		.filter(
			(element) =>
				!element.closest('[hidden]') &&
				!element.hasAttribute('disabled') &&
				element.getClientRects().length > 0,
		);
	const match =
		bookmark &&
		controls.find((element) => element.dataset.ticketFocus === JSON.stringify(bookmark.target));
	const rows = controls.filter((element) =>
		element.dataset.ticketFocus?.includes('"control":"open"'),
	);
	const fallback =
		rows[Math.min(fallbackIndex, rows.length - 1)] ??
		controls.find((element) => element.dataset.ticketFocus?.includes('"kind":"lane"')) ??
		controls.find((element) => element.dataset.ticketFocus?.includes('"control":"new"'));
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
