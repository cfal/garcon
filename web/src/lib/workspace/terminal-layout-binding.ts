import type { WorkspaceLayoutRestoreSource } from './layout-schema.js';

interface TerminalLayoutReconciler {
	reconcileTerminals(
		terminalIds: readonly string[],
		options: { deriveLauncher: boolean },
	): Promise<void>;
}

interface TerminalLayoutBindingDeps {
	restoreSource: WorkspaceLayoutRestoreSource;
	workspace: TerminalLayoutReconciler;
	isLauncherDismissed(): boolean;
	onError(error: unknown): void;
}

export class TerminalLayoutBinding {
	#receivedSuccessfulList = false;
	#destroyed = false;
	#reconciliationTail = Promise.resolve();

	constructor(private readonly deps: TerminalLayoutBindingDeps) {}

	handleSuccessfulList(terminalIds: readonly string[]): void {
		if (this.#destroyed) return;
		const isFirstSuccessfulList = !this.#receivedSuccessfulList;
		this.#receivedSuccessfulList = true;
		const deriveLauncher =
			isFirstSuccessfulList &&
			terminalIds.length === 0 &&
			(this.deps.restoreSource === 'absent' || this.deps.restoreSource === 'fallback') &&
			!this.deps.isLauncherDismissed();
		const snapshot = [...terminalIds];
		this.#reconciliationTail = this.#reconciliationTail
			.then(async () => {
				if (this.#destroyed) return;
				await this.deps.workspace.reconcileTerminals(snapshot, { deriveLauncher });
			})
			.catch((error: unknown) => {
				if (!this.#destroyed) this.deps.onError(error);
			});
	}

	destroy(): void {
		this.#destroyed = true;
	}
}
