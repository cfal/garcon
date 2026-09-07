export type ChatBoardPresentationBand = 'narrow' | 'medium' | 'wide';

type PendingFocusTarget =
	| { readonly kind: 'lane'; readonly columnId: string }
	| {
			readonly kind: 'occurrence';
			readonly columnId: string;
			readonly occurrenceKey: string;
			readonly control: string;
	  };

export class ChatBoardFocusController {
	#root: HTMLElement | null = null;
	#pendingFocus: PendingFocusTarget | null = null;
	#pendingBand: ChatBoardPresentationBand | null = null;
	#pendingActiveColumnId: string | null = null;

	setRoot(root: HTMLElement | null): void {
		this.#root = root;
	}

	preparePresentationChange(
		nextBand: ChatBoardPresentationBand,
		activeColumnId: string | null,
	): void {
		this.#pendingBand = nextBand;
		this.#pendingActiveColumnId = activeColumnId;
		if (!this.#root) return;
		const active = document.activeElement;
		if (this.#pendingFocus) {
			if (
				active instanceof HTMLElement &&
				active !== document.body &&
				!this.#root.contains(active)
			) {
				this.#clearPendingFocus();
			}
			return;
		}
		if (!(active instanceof HTMLElement) || !this.#root.contains(active)) return;
		const tab = active.closest<HTMLElement>('[data-chat-board-tab]');
		if (tab?.dataset.chatBoardTab) {
			this.#pendingFocus = { kind: 'lane', columnId: tab.dataset.chatBoardTab };
			return;
		}
		const lane = active.closest<HTMLElement>('[data-chat-board-column-id]');
		const columnId = lane?.dataset.chatBoardColumnId;
		if (!columnId) return;
		const occurrence = active.closest<HTMLElement>('[data-chat-board-occurrence]');
		const control = active.closest<HTMLElement>('[data-chat-board-focus-target]');
		const occurrenceKey = occurrence?.dataset.chatBoardOccurrence;
		const controlName = control?.dataset.chatBoardFocusTarget;
		this.#pendingFocus =
			occurrenceKey && controlName
				? { kind: 'occurrence', columnId, occurrenceKey, control: controlName }
				: { kind: 'lane', columnId };
	}

	completePresentationChange(): void {
		const target = this.#pendingFocus;
		const pendingBand = this.#pendingBand;
		const activeColumnId = this.#pendingActiveColumnId;
		this.#clearPendingFocus();
		if (!target) return;
		if (pendingBand === 'narrow' && activeColumnId && target.columnId !== activeColumnId) {
			this.focusLane(activeColumnId);
			return;
		}
		if (target.kind === 'occurrence' && this.#focusOccurrenceControl(target)) return;
		this.focusLane(target.columnId);
	}

	#clearPendingFocus(): void {
		this.#pendingFocus = null;
		this.#pendingBand = null;
		this.#pendingActiveColumnId = null;
	}

	#focusOccurrenceControl(target: Extract<PendingFocusTarget, { kind: 'occurrence' }>): boolean {
		const control = this.#root?.querySelector<HTMLElement>(
			`[data-chat-board-occurrence="${CSS.escape(target.occurrenceKey)}"] [data-chat-board-focus-target="${CSS.escape(target.control)}"]`,
		);
		if (!control || control.matches(':disabled')) return false;
		control.focus({ preventScroll: true });
		return true;
	}

	focusOccurrence(columnId: string, chatId: string): boolean {
		const occurrence = this.#root?.querySelector<HTMLElement>(
			`[data-chat-board-occurrence="${CSS.escape(`${columnId}:${chatId}`)}"] [data-chat-board-open]`,
		);
		if (!occurrence) return false;
		occurrence.focus({ preventScroll: true });
		return true;
	}

	focusLane(columnId: string): boolean {
		const heading = this.#root?.querySelector<HTMLElement>(
			`[data-chat-board-lane-heading="${CSS.escape(columnId)}"]`,
		);
		if (!heading) return false;
		heading.focus({ preventScroll: true });
		return true;
	}

	focusToolbar(): void {
		this.#root
			?.querySelector<HTMLElement>('[data-chat-board-selector], [data-chat-board-create]')
			?.focus({ preventScroll: true });
	}
}
