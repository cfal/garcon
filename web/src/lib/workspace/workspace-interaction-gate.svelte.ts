export interface WorkspaceInteractionRegistration {
	cancelApplicationDrag(): void;
}

export class WorkspaceInteractionGate {
	#registration = $state.raw<WorkspaceInteractionRegistration | null>(null);

	register(registration: WorkspaceInteractionRegistration): () => void {
		this.#registration = registration;
		return () => {
			if (this.#registration === registration) this.#registration = null;
		};
	}

	cancelBeforeInertTransition(): void {
		this.#registration?.cancelApplicationDrag();
	}
}
