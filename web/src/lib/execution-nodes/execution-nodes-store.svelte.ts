import { getExecutionNodes } from '$lib/api/execution-nodes.js';
import {
	effectiveNodeId,
	parseExecutionNodes,
	type ExecutionNodeSnapshot,
} from '$shared/execution-nodes';

const localFallback: readonly ExecutionNodeSnapshot[] = [
	{
		id: 'local',
		label: 'Local',
		kind: 'local',
		enabled: true,
		direction: null,
		availability: 'ready',
		instanceId: null,
		projectBasePath: null,
		lastError: null,
		machineServices: { files: true, git: true, gh: true, terminals: true },
	},
];

export class ExecutionNodesStore {
	readonly #listeners = new Set<() => void>();
	#snapshot = $state.raw<readonly ExecutionNodeSnapshot[] | null>(null);
	error = $state<string | null>(null);
	loading = $state(false);
	#version = 0;
	#request: Promise<void> | null = null;

	constructor(private readonly read = getExecutionNodes) {}

	get nodes(): readonly ExecutionNodeSnapshot[] {
		return this.#snapshot ?? localFallback;
	}
	get hasSnapshot(): boolean {
		return this.#snapshot !== null;
	}
	get hasRemoteNodes(): boolean {
		return this.nodes.some((node) => node.id !== 'local');
	}

	get(id?: string | null): ExecutionNodeSnapshot | undefined {
		return this.nodes.find((node) => node.id === effectiveNodeId(id));
	}

	label(id?: string | null): string {
		return this.get(id)?.label ?? (effectiveNodeId(id) === 'local' ? 'Local' : this.hasSnapshot ? 'Unavailable node' : effectiveNodeId(id));
	}

	isReady(id?: string | null): boolean {
		const node = this.get(id);
		return node?.enabled === true && node.availability === 'ready';
	}

	filesAvailable(id?: string | null): boolean {
		return this.isReady(id) && this.get(id)?.machineServices.files === true;
	}

	gitAvailable(id?: string | null): boolean {
		return this.isReady(id) && this.get(id)?.machineServices.git === true;
	}

	ghAvailable(id?: string | null): boolean {
		return this.gitAvailable(id) && this.get(id)?.machineServices.gh === true;
	}

	gitContextKey(id?: string | null): string {
		const node = this.get(id);
		return JSON.stringify([
			effectiveNodeId(id),
			node?.instanceId,
			node?.projectBasePath,
			node?.enabled,
			node?.availability,
			node?.machineServices.git,
			node?.machineServices.gh,
		]);
	}

	pathContextKey(id?: string | null): string {
		const node = this.get(id);
		return JSON.stringify([
			effectiveNodeId(id),
			node?.instanceId,
			node?.projectBasePath,
			node?.enabled,
			node?.availability,
			node?.machineServices.files,
		]);
	}

	applySnapshot(value: unknown): void {
		const nodes = parseExecutionNodes(value);
		if (!nodes) throw new Error('Invalid execution nodes snapshot');
		this.#snapshot = nodes;
		this.error = null;
		this.#version += 1;
		for (const listener of this.#listeners) listener();
	}

	onChanged(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async refresh(): Promise<void> {
		if (this.#request) return this.#request;
		const version = this.#version;
		this.loading = true;
		this.#request = this.read()
			.then((nodes) => {
				if (version === this.#version) this.applySnapshot(nodes);
			})
			.catch((error: unknown) => {
				if (version === this.#version)
					this.error = error instanceof Error ? error.message : 'Unable to load execution nodes';
			})
			.finally(() => {
				this.loading = false;
				this.#request = null;
			});
		return this.#request;
	}

	async refreshAfterMutation(): Promise<void> {
		await this.#request;
		await this.refresh();
	}
}

export function executionNodeStatus(node: ExecutionNodeSnapshot): string {
	if (!node.enabled) return 'Disabled';
	if (node.availability === 'ready') return 'Ready';
	return node.direction === 'node-connects' ? 'Waiting for connection' : 'Offline';
}
