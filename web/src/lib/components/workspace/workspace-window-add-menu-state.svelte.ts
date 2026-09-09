import { tick, untrack } from 'svelte';
import {
	resolveWorkspaceWindowInlineAddActionCount,
	type WorkspaceWindowTabMeasure,
} from './workspace-window-add-layout.js';

interface WorkspaceWindowAddMenuOptions {
	readonly windowId: string;
	readonly measure: WorkspaceWindowTabMeasure | null;
	readonly actionIds: readonly string[];
	readonly hasUnplacedTerminalSessions: boolean;
}

export class WorkspaceWindowAddMenuState {
	controlsElement: HTMLElement | undefined;
	overflowMenuContent = $state<HTMLElement | null>(null);
	overflowMenuOpen = $state(false);
	inlineActionCount = $state(0);
	#pendingPromotedAction: HTMLElement | null = null;

	constructor(private readonly options: WorkspaceWindowAddMenuOptions) {
		$effect.pre(() => {
			const focusedElement = this.#focusedControl();
			const { actionIds, measure } = this.options;
			// Saved terminals replace the inline terminal action with a menu trigger.
			void this.options.hasUnplacedTerminalSessions;
			const currentInlineCount = Math.min(
				actionIds.length,
				Math.max(
					0,
					untrack(() => this.inlineActionCount),
				),
			);
			const nextInlineCount = resolveWorkspaceWindowInlineAddActionCount({
				measure,
				eligibleCount: actionIds.length,
				currentInlineCount,
			});
			const focusedActionId = focusedElement ? this.#actionId(focusedElement) : undefined;
			const focusedActionWasPromoted =
				focusedElement !== null &&
				focusedActionId !== undefined &&
				this.overflowMenuContent?.contains(focusedElement) &&
				actionIds.slice(0, nextInlineCount).includes(focusedActionId);
			if (focusedActionWasPromoted) this.#pendingPromotedAction = focusedElement;
			if (focusedActionWasPromoted || nextInlineCount === actionIds.length) {
				this.overflowMenuOpen = false;
			}
			if (nextInlineCount !== untrack(() => this.inlineActionCount))
				this.inlineActionCount = nextInlineCount;
			if (focusedElement) void this.#restoreFocus(focusedElement);
		});
	}

	#actionId(element: HTMLElement): string | undefined {
		return element.dataset.workspaceWindowAddGroup ?? element.dataset.workspaceWindowAddAction;
	}

	#focusedControl(): HTMLElement | null {
		const focusedElement = document.activeElement;
		if (!(focusedElement instanceof HTMLElement)) return null;
		if (this.controlsElement?.contains(focusedElement)) return focusedElement;
		const menuHasFocus = [
			...document.querySelectorAll<HTMLElement>('[data-workspace-window-add-menu]'),
		].some(
			(element) =>
				element.dataset.workspaceWindowAddMenu === this.options.windowId &&
				element.contains(focusedElement),
		);
		return menuHasFocus ? focusedElement : null;
	}

	async #restoreFocus(previouslyFocused: HTMLElement): Promise<void> {
		const actionId = this.#actionId(previouslyFocused);
		const isPromotion = this.#pendingPromotedAction === previouslyFocused;
		try {
			await tick();
			if (!this.controlsElement?.isConnected || previouslyFocused.isConnected) return;
			if (
				isPromotion &&
				(this.#pendingPromotedAction !== previouslyFocused || this.overflowMenuOpen)
			)
				return;
			if (document.activeElement !== document.body && !this.#focusedControl()) return;
			const trigger = this.controlsElement.querySelector<HTMLButtonElement>(
				'[data-workspace-window-add-trigger]',
			);
			const matchingAction = actionId
				? this.controlsElement.querySelector<HTMLButtonElement>(
						`[data-workspace-window-add-action="${CSS.escape(actionId)}"]`,
					)
				: null;
			const fallbackControl = this.controlsElement.querySelector<HTMLButtonElement>(
				'[data-workspace-window-add-inline]:not(:disabled), [data-workspace-window-add-terminal-trigger]',
			);
			(matchingAction ?? trigger ?? fallbackControl)?.focus();
		} finally {
			if (this.#pendingPromotedAction === previouslyFocused) this.#pendingPromotedAction = null;
		}
	}

	handleOpenAutoFocus(event: Event): void {
		event.preventDefault();
		const content = this.overflowMenuContent;
		const trigger = this.controlsElement?.querySelector<HTMLButtonElement>(
			'[data-workspace-window-add-trigger]',
		);
		requestAnimationFrame(() => {
			if (!this.overflowMenuOpen || !content?.isConnected || content !== this.overflowMenuContent)
				return;
			const activeElement = document.activeElement;
			if (activeElement !== document.body && activeElement !== trigger) return;
			content.focus({ preventScroll: true });
		});
	}

	handleCloseAutoFocus(event: Event): void {
		if (this.#pendingPromotedAction) event.preventDefault();
	}
}
