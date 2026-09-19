import * as api from '$lib/api/execution-nodes.js';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import type { ExecutionNodeDirection, ExecutionNodeSnapshot } from '$shared/execution-nodes';

export class ExecutionNodeEditor {
	id = $state<string | null>(null);
	label = $state('');
	direction = $state<ExecutionNodeDirection>('node-connects');
	connectionUrl = $state('');
	allowInsecureDevelopment = $state(false);
	enabled = $state(true);
	revealed = $state(false);
	busy = $state(false);
	error = $state<string | null>(null);
	confirmDelete = $state(false);
	#version = 0;
	#originalUrl = '';
	#originalDirection: ExecutionNodeDirection = 'node-connects';
	#originalInsecure = false;
	#originalEnabled = true;

	constructor(private readonly nodes: ExecutionNodesStore, private readonly transport = api) {}

	clear(): void {
		this.#version += 1;
		this.id = null;
		this.label = '';
		this.direction = 'node-connects';
		this.connectionUrl = '';
		this.#originalUrl = '';
		this.allowInsecureDevelopment = false;
		this.enabled = true;
		this.revealed = false;
		this.busy = false;
		this.error = null;
		this.confirmDelete = false;
	}

	async edit(node: ExecutionNodeSnapshot): Promise<void> {
		this.clear();
		this.id = node.id;
		this.label = node.label;
		this.direction = node.direction ?? 'node-connects';
		this.enabled = this.#originalEnabled = node.enabled;
		const version = this.#version;
		this.busy = true;
		try {
			const connection = await this.transport.getExecutionNodeConnection(node.id);
			if (version !== this.#version) return;
			this.connectionUrl = this.#originalUrl = connection.connectionUrl;
			this.#originalDirection = this.direction;
			this.allowInsecureDevelopment = this.#originalInsecure = connection.allowInsecureDevelopment;
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to load connection';
		} finally {
			if (version === this.#version) this.busy = false;
		}
	}

	async save(): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		this.error = null;
		const version = this.#version;
		const previousNodes = this.nodes.nodes;
		try {
			if (this.id) {
				const connectionChanged = this.connectionUrl !== this.#originalUrl || this.direction !== this.#originalDirection
					|| this.allowInsecureDevelopment !== this.#originalInsecure;
				const nodes = await this.transport.updateExecutionNode(this.id, {
					label: this.label.trim(),
					...(this.enabled !== this.#originalEnabled ? { enabled: this.enabled } : {}),
					...(connectionChanged ? { connection: { direction: this.direction, connectionUrl: this.connectionUrl.trim(), allowInsecureDevelopment: this.allowInsecureDevelopment } } : {}),
				});
				if (this.nodes.nodes === previousNodes) this.nodes.applySnapshot(nodes);
				else await this.nodes.refreshAfterMutation();
				if (version !== this.#version) return false;
			} else {
				const result = await this.transport.createExecutionNode({
					label: this.label.trim(), allowInsecureDevelopment: this.allowInsecureDevelopment,
					...(this.direction === 'node-connects' ? { direction: 'node-connects' } : { direction: 'controller-connects', connectionUrl: this.connectionUrl.trim() }),
				});
				await this.nodes.refreshAfterMutation();
				if (version !== this.#version) return false;
				this.id = result.id;
				this.connectionUrl = result.connectionUrl;
				this.allowInsecureDevelopment = result.allowInsecureDevelopment;
				this.revealed = true;
			}
			this.#originalUrl = this.connectionUrl;
			this.#originalDirection = this.direction;
			this.#originalInsecure = this.allowInsecureDevelopment;
			this.#originalEnabled = this.enabled;
			return true;
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to save execution node';
			return false;
		} finally {
			if (version === this.#version) this.busy = false;
		}
	}

	async remove(): Promise<boolean> {
		if (!this.id || this.busy || !this.confirmDelete) return false;
		this.busy = true;
		const version = this.#version;
		const previousNodes = this.nodes.nodes;
		try {
			const nodes = await this.transport.removeExecutionNode(this.id);
			if (this.nodes.nodes === previousNodes) this.nodes.applySnapshot(nodes);
			else await this.nodes.refreshAfterMutation();
			if (version !== this.#version) return false;
			this.clear();
			return true;
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to remove execution node';
			return false;
		} finally {
			if (version === this.#version) this.busy = false;
		}
	}
}
