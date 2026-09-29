import { setExecutors } from '$lib/context';
import type { ExecutorSnapshot } from '$shared/executors';
import { ExecutorsStore } from '../executors-store.svelte.js';
import { localExecutor } from './fixtures';

// Null leaves the store without a snapshot, as before the first executor list loads.
export function setExecutorsTestContext(
	executors: readonly ExecutorSnapshot[] | null = [localExecutor],
): ExecutorsStore {
	const store = new ExecutorsStore(async () => executors ?? []);
	if (executors) store.applySnapshot(executors);
	setExecutors(store);
	return store;
}
