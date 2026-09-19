import { validateStart } from '$lib/api/chats.js';

export class NodeHandoffProjectState {
	target = $state<{ chatId: string; nodeId: string } | null>(null);
	projectPath = $state('');
	error = $state<string | null>(null);
	checking = $state(false);
	#resolve: ((path: string | null) => void) | null = null;
	#version = 0;

	ask(chatId: string, nodeId: string, projectPath: string): Promise<string | null> {
		this.cancel();
		this.target = { chatId, nodeId };
		this.projectPath = projectPath;
		return new Promise((resolve) => { this.#resolve = resolve; });
	}

	async confirm(): Promise<void> {
		if (!this.target || this.checking || !this.projectPath.trim()) return;
		const version = this.#version;
		const projectPath = this.projectPath.trim();
		this.checking = true;
		this.error = null;
		try {
			const result = await validateStart(projectPath, { nodeId: this.target.nodeId });
			if (version !== this.#version || this.projectPath.trim() !== projectPath) return;
			if (!result.valid) { this.error = result.error ?? 'Project folder is unavailable'; return; }
			const resolve = this.#resolve;
			this.#resolve = null;
			this.cancel();
			resolve?.(projectPath);
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to inspect project folder';
		} finally {
			if (version === this.#version) this.checking = false;
		}
	}

	cancel(): void {
		this.#version += 1;
		this.#resolve?.(null);
		this.#resolve = null;
		this.target = null;
		this.projectPath = '';
		this.checking = false;
		this.error = null;
	}
}
