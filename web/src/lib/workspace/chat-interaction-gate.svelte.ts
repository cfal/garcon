export interface ChatInteractionRegistration {
	cancelApplicationDrag(): void;
}

export class ChatInteractionGate {
	#registration = $state.raw<ChatInteractionRegistration | null>(null);
	#presented = $state(true);
	#mainInert = $state(false);

	get isChatDropEligible(): boolean {
		return this.#presented && !this.#mainInert;
	}

	register(registration: ChatInteractionRegistration): () => void {
		this.#registration = registration;
		return () => {
			if (this.#registration === registration) this.#registration = null;
		};
	}

	setPresented(presented: boolean): void {
		this.#presented = presented;
	}

	setMainInert(mainInert: boolean): void {
		this.#mainInert = mainInert;
	}

	cancelBeforeInertTransition(): void {
		this.#registration?.cancelApplicationDrag();
	}
}
