import { setExecutionNodes } from '$lib/context';
import type { ExecutionNodeSnapshot } from '$shared/execution-nodes';
import { ExecutionNodesStore } from '../execution-nodes-store.svelte.js';
import { localExecutionNode } from './fixtures';

export function setExecutionNodesTestContext(nodes: readonly ExecutionNodeSnapshot[] = [localExecutionNode]): ExecutionNodesStore {
	const store = new ExecutionNodesStore(async () => nodes);
	store.applySnapshot(nodes);
	setExecutionNodes(store);
	return store;
}
