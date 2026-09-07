interface PromptComposerFocusDeliveryOptions {
	selectedChatId: string | null;
	disabled: boolean;
	visible: boolean;
	textarea: HTMLTextAreaElement | undefined;
	userInteractionGeneration(): number;
	resize(): void;
}

interface PendingFocusRequest {
	chatId: string;
	requestId: number;
	userInteractionGeneration: number;
}

const FOCUS_RETRY_TIMEOUT_MS = 500;

export class PromptComposerFocusDelivery {
	#nextRequestId = 0;
	#pending = $state<PendingFocusRequest | null>(null);

	request(chatId: string | null, userInteractionGeneration: number): void {
		if (!chatId) {
			this.#pending = null;
			return;
		}
		this.#nextRequestId += 1;
		this.#pending = {
			chatId,
			requestId: this.#nextRequestId,
			userInteractionGeneration,
		};
	}

	deliver(options: PromptComposerFocusDeliveryOptions): (() => void) | undefined {
		const request = this.#pending;
		const target = options.textarea;
		if (!request || options.disabled || !options.visible || !target) return;
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
			if (request.userInteractionGeneration !== options.userInteractionGeneration()) {
				this.#complete(request);
				return;
			}
			options.resize();
			target.focus();
			if (
				document.activeElement === target ||
				performance.now() - startedAt >= FOCUS_RETRY_TIMEOUT_MS
			) {
				this.#complete(request);
				return;
			}
			frameId = requestAnimationFrame(attempt);
		};
		frameId = requestAnimationFrame(attempt);
		return () => cancelAnimationFrame(frameId);
	}

	#complete(request: PendingFocusRequest): void {
		if (this.#pending?.requestId === request.requestId) this.#pending = null;
	}
}
