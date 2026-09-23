import { validateStart } from '$lib/api/chats.js';
import type { ResolvedModelSelection } from '$shared/start-selection';

export interface NodeHandoffModel extends ResolvedModelSelection {
	agentId: string;
}
export interface NodeHandoffDestination {
	projectPath: string;
	selection: NodeHandoffModel;
}

export class NodeHandoffProjectState {
	target = $state<{ chatId: string; nodeId: string } | null>(null);
	projectPath = $state('');
	selection = $state<NodeHandoffModel | null>(null);
	error = $state<string | null>(null);
	checking = $state(false);
	#resolve: ((destination: NodeHandoffDestination | null) => void) | null = null;
	#version = 0;

	constructor(
		private readonly isAvailable: (nodeId: string, selection: NodeHandoffModel) => boolean,
	) {}

	get canConfirm(): boolean {
		if (!this.target || !this.selection || !this.projectPath.trim() || this.checking) return false;
		return this.isAvailable(this.target.nodeId, this.selection);
	}

	ask(
		chatId: string,
		nodeId: string,
		projectPath: string,
		selection: NodeHandoffModel,
	): Promise<NodeHandoffDestination | null> {
		this.cancel();
		this.target = { chatId, nodeId };
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
		const nodeId = this.target.nodeId;
		this.checking = true;
		this.error = null;
		try {
			const result = await validateStart(projectPath, { nodeId });
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
			if (!this.isAvailable(nodeId, selection)) {
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
