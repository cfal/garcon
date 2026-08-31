import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte';

export class WorkMapController implements PortableSingletonController {
	query = $state('');
	#collapsedNodeKeys = $state<ReadonlySet<string>>(new Set());

	get collapsedNodeKeys(): ReadonlySet<string> {
		return this.#collapsedNodeKeys;
	}

	setQuery(query: string): void {
		this.query = query;
	}

	toggleNode(key: string): void {
		const next = new Set(this.#collapsedNodeKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this.#collapsedNodeKeys = next;
	}

	expandAll(): void {
		this.#collapsedNodeKeys = new Set();
	}

	collapseAll(keys: readonly string[]): void {
		this.#collapsedNodeKeys = new Set(keys);
	}

	reconcileNodeKeys(validKeys: ReadonlySet<string>): void {
		const next = new Set([...this.#collapsedNodeKeys].filter((key) => validKeys.has(key)));
		if (next.size !== this.#collapsedNodeKeys.size) this.#collapsedNodeKeys = next;
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		void projectState;
	}

	setPresentationVisible(visible: boolean): void {
		void visible;
	}

	dispose(): void {
		this.query = '';
		this.#collapsedNodeKeys = new Set();
	}
}
