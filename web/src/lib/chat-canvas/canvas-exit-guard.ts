import type { CanvasSession } from './canvas-session.svelte.js';
import type { CanvasRecoveryPort } from './canvas-recovery.js';

export class CanvasExitGuard {
	#release: (() => void) | null = null;

	constructor(
		private readonly recovery: CanvasRecoveryPort,
		private readonly session: () => CanvasSession | null,
	) {}

	activate(): void {
		if (this.#release || typeof window === 'undefined') return;
		const preserve = () => this.session()?.preserveForExit();
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!this.#hasUnsavedWork()) return;
			preserve();
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('pagehide', preserve);
		window.addEventListener('beforeunload', beforeUnload);
		this.#release = () => {
			window.removeEventListener('pagehide', preserve);
			window.removeEventListener('beforeunload', beforeUnload);
		};
	}

	dispose(): void {
		this.#release?.();
		this.#release = null;
	}

	#hasUnsavedWork(): boolean {
		const current = this.session();
		if (current?.dirty || current?.conflict) return true;
		try {
			return this.recovery.list().length > 0;
		} catch {
			return true;
		}
	}
}
