import { validateStart } from '$lib/api/chats.js';
import type { ResolvedModelSelection } from '$shared/start-selection';

export interface ExecutorHandoffModel extends ResolvedModelSelection {
	agentId: string;
}
export interface ExecutorHandoffDestination {
	projectPath: string;
	selection: ExecutorHandoffModel;
}

export class ExecutorHandoffProjectState {
	target = $state<{ chatId: string; executorId: string } | null>(null);
	projectPath = $state('');
	selection = $state<ExecutorHandoffModel | null>(null);
	error = $state<string | null>(null);
	checking = $state(false);
	#resolve: ((destination: ExecutorHandoffDestination | null) => void) | null = null;
	#version = 0;

	constructor(
		private readonly isAvailable: (executorId: string, selection: ExecutorHandoffModel) => boolean,
	) {}

	get canConfirm(): boolean {
		if (!this.target || !this.selection || !this.projectPath.trim() || this.checking) return false;
		return this.isAvailable(this.target.executorId, this.selection);
	}

	ask(
		chatId: string,
		executorId: string,
		projectPath: string,
		selection: ExecutorHandoffModel,
	): Promise<ExecutorHandoffDestination | null> {
		this.cancel();
		this.target = { chatId, executorId };
		this.projectPath = projectPath;
		this.selection = selection;
		return new Promise((resolve) => {
			this.#resolve = resolve;
		});
	}

	async confirm(): Promise<void> {
		if (!this.canConfirm || !this.target || !this.selection) return;
		const version = this.#version;
		const projectPath = this.projectPath.trim();
		const selection = this.selection;
		const executorId = this.target.executorId;
		this.checking = true;
		this.error = null;
		try {
			const result = await validateStart(projectPath, { executorId });
			if (
				version !== this.#version ||
				this.projectPath.trim() !== projectPath ||
				this.selection !== selection
			)
				return;
			if (!result.valid) {
				this.error = result.error ?? 'Project folder is unavailable';
				return;
			}
			if (!this.isAvailable(executorId, selection)) {
				this.error = 'Execution target is unavailable';
				return;
			}
			const resolve = this.#resolve;
			this.#resolve = null;
			this.cancel();
			resolve?.({ projectPath, selection });
		} catch (error) {
			if (version === this.#version && this.projectPath.trim() === projectPath) {
				this.error = error instanceof Error ? error.message : 'Unable to inspect project folder';
			}
		} finally {
			if (version === this.#version) this.checking = false;
		}
	}

	cancel(): void {
		this.#version += 1;
		this.#resolve?.(null);
		this.#resolve = null;
		this.target = null;
		this.selection = null;
		this.projectPath = '';
		this.checking = false;
		this.error = null;
	}
}
