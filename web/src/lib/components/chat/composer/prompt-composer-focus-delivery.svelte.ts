import { untrack } from 'svelte';
import type { AppShellStore } from '$lib/stores/app-shell.svelte.js';

interface PromptComposerFocusDeliveryOptions {
	selectedChatId: string | null;
	disabled: boolean;
	visible: boolean;
	target: HTMLElement | undefined;
	userInteractionGeneration(): number;
	drawerFocusBlocked(): boolean;
}

interface PendingFocusRequest {
	chatId: string;
	userInteractionGeneration: number;
	origin: 'default' | 'drawer-selection';
}

const FOCUS_RETRY_TIMEOUT_MS = 500;

export class PromptComposerFocusDelivery {
	#lastShellRequestId = 0;
	#pending = $state.raw<PendingFocusRequest | null>(null);

	constructor(private readonly options: PromptComposerFocusDeliveryOptions) {}

	requestCurrentChat(): void {
		this.#request(this.options.selectedChatId, this.options.userInteractionGeneration(), 'default');
	}

	acceptShellRequest({ id, drawerSelection }: AppShellStore['composerFocusRequest']): void {
		if (id === 0 || id === this.#lastShellRequestId) return;
		this.#lastShellRequestId = id;
		untrack(() => {
			if (drawerSelection) {
				this.#request(drawerSelection.chatId, drawerSelection.userInteractionGeneration, 'drawer-selection');
			} else {
				this.requestCurrentChat();
			}
		});
	}

	#request(
		chatId: string | null,
		userInteractionGeneration: number,
		origin: PendingFocusRequest['origin'],
	): void {
		this.#pending = chatId ? { chatId, userInteractionGeneration, origin } : null;
	}

	deliver(): (() => void) | undefined {
		const options = this.options;
		const request = this.#pending;
		const target = options.target;
		if (!request) return;
		const drawer = request.origin === 'drawer-selection';
		if (drawer && options.drawerFocusBlocked()) {
			this.#complete(request);
			return;
		}
		if (options.disabled || !options.visible || !target) return;
		if (
			request.chatId !== options.selectedChatId ||
			request.userInteractionGeneration !== options.userInteractionGeneration()
		) {
			this.#complete(request);
			return;
		}

		const startedAt = performance.now();
		let frameId = 0;
		const attempt = (): void => {
			if (this.#pending !== request) return;
			if (
				request.userInteractionGeneration !== options.userInteractionGeneration() ||
				(drawer && (request.chatId !== options.selectedChatId || options.drawerFocusBlocked()))
			) {
				this.#complete(request);
				return;
			}
			if (drawer && (options.disabled || !options.visible || target !== options.target)) return;
			const available = !drawer ||
				(target.isConnected && !target.closest('[hidden], [inert]') && !target.matches(':disabled'));
			if (available) {
				target.focus();
			}
			if (
				(available && document.activeElement === target) ||
				performance.now() - startedAt >= FOCUS_RETRY_TIMEOUT_MS
			) {
				this.#complete(request);
				return;
			}
			frameId = requestAnimationFrame(attempt);
		};
		// The delivery effect runs after DOM commit. Waiting a frame here can lose the first key.
		if (drawer) untrack(attempt);
		else frameId = requestAnimationFrame(attempt);
		return () => cancelAnimationFrame(frameId);
	}

	#complete(request: PendingFocusRequest): void {
		if (this.#pending === request) this.#pending = null;
	}
}
