export type ChatBoardPresentationBand = 'narrow' | 'medium' | 'wide';

export class ChatBoardFocusController {
	#root: HTMLElement | null = null;
	#handoffColumnId: string | null = null;

	setRoot(root: HTMLElement | null): void {
		this.#root = root;
	}

	preparePresentationChange(
		nextBand: ChatBoardPresentationBand,
		activeColumnId: string | null,
	): void {
		if (nextBand !== 'narrow' || !activeColumnId || !this.#root) return;
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !this.#root.contains(active)) return;
		const lane = active.closest<HTMLElement>('[data-chat-board-column-id]');
		if (lane && lane.dataset.chatBoardColumnId !== activeColumnId) {
			this.#handoffColumnId = activeColumnId;
		}
	}

	completePresentationChange(): void {
		if (!this.#handoffColumnId) return;
		const columnId = this.#handoffColumnId;
		this.#handoffColumnId = null;
		this.focusLane(columnId);
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
