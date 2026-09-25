import { setExecutors } from '$lib/context';
import type { ExecutorSnapshot } from '$shared/executors';
import { ExecutorsStore } from '../executors-store.svelte.js';
import { localExecutor } from './fixtures';

export function setExecutorsTestContext(executors: readonly ExecutorSnapshot[] = [localExecutor]): ExecutorsStore {
	const store = new ExecutorsStore(async () => executors);
	store.applySnapshot(executors);
	setExecutors(store);
	return store;
}
