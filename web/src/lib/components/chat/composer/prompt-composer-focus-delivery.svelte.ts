import { untrack } from 'svelte';

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
	requestId: number;
	userInteractionGeneration: number;
	origin: 'default' | 'drawer-selection';
}

const FOCUS_RETRY_TIMEOUT_MS = 500;

export class PromptComposerFocusDelivery {
	#nextRequestId = 0;
	#pending = $state<PendingFocusRequest | null>(null);

	request(
		chatId: string | null,
		userInteractionGeneration: number,
		origin: PendingFocusRequest['origin'] = 'default',
	): void {
		if (!chatId) {
			this.#pending = null;
			return;
		}
		this.#nextRequestId += 1;
		this.#pending = {
			chatId,
			requestId: this.#nextRequestId,
			userInteractionGeneration,
			origin,
		};
	}

	deliver(options: PromptComposerFocusDeliveryOptions): (() => void) | undefined {
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
			if (this.#pending?.requestId !== request.requestId) return;
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
		if (this.#pending?.requestId === request.requestId) this.#pending = null;
	}
}
