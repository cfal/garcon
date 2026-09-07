export type ChatBoardPresentationBand = 'narrow' | 'medium' | 'wide';

type PendingFocusTarget =
	| { readonly kind: 'lane'; readonly columnId: string }
	| {
			readonly kind: 'occurrence';
			readonly columnId: string;
			readonly occurrenceKey: string;
			readonly control: string;
	  };

interface PendingPresentationFocus {
	readonly target: PendingFocusTarget;
	readonly band: ChatBoardPresentationBand;
	readonly activeColumnId: string | null;
}

export class ChatBoardFocusController {
	#root: HTMLElement | null = null;
	#pending: PendingPresentationFocus | null = null;

	setRoot(root: HTMLElement | null): void {
		this.#root = root;
	}

	preparePresentationChange(
		nextBand: ChatBoardPresentationBand,
		activeColumnId: string | null,
	): void {
		if (this.#pending) {
			const pending = { ...this.#pending, band: nextBand, activeColumnId };
			this.#pending = pending;
			if (!this.#root) return;
			const active = document.activeElement;
			if (!(active instanceof HTMLElement) || active === document.body) return;
			if (!this.#root.contains(active)) {
				this.#pending = null;
				return;
			}
			const target = this.#captureFocusTarget(active);
			if (!target) {
				this.#pending = null;
				return;
			}
			this.#pending = { ...pending, target };
			return;
		}
		if (!this.#root) return;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !this.#root.contains(active)) return;
		const target = this.#captureFocusTarget(active);
		if (target) this.#pending = { target, band: nextBand, activeColumnId };
	}

	#captureFocusTarget(active: HTMLElement): PendingFocusTarget | null {
		const tab = active.closest<HTMLElement>('[data-chat-board-tab]');
		if (tab?.dataset.chatBoardTab) {
			return { kind: 'lane', columnId: tab.dataset.chatBoardTab };
		}
		const lane = active.closest<HTMLElement>('[data-chat-board-column-id]');
		const columnId = lane?.dataset.chatBoardColumnId;
		if (!columnId) return null;
		const occurrence = active.closest<HTMLElement>('[data-chat-board-occurrence]');
		const control = active.closest<HTMLElement>('[data-chat-board-focus-target]');
		const occurrenceKey = occurrence?.dataset.chatBoardOccurrence;
		const controlName = control?.dataset.chatBoardFocusTarget;
		if (!occurrenceKey || !controlName) return { kind: 'lane', columnId };
		return { kind: 'occurrence', columnId, occurrenceKey, control: controlName };
	}

	completePresentationChange(): void {
		const pending = this.#pending;
		this.#pending = null;
		if (!pending) return;
		const { target, band, activeColumnId } = pending;
		if (
			band === 'narrow' &&
			activeColumnId &&
			target.columnId !== activeColumnId
		) {
			this.focusLane(activeColumnId);
			return;
		}
		if (target.kind === 'occurrence' && this.#focusOccurrenceControl(target)) return;
		this.focusLane(target.columnId);
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
