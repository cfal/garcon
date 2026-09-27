import type { ExecutorSnapshot } from '$shared/executors';

// The controller learns a remote executor's agent inventory only after it connects,
// and chat rows derive native-history capability from that inventory. Reports when
// an executor becomes ready or disappears so rows can be refreshed; the first
// snapshot is the baseline for rows loaded alongside it.
export class ExecutorInventoryChanges {
	#ready: ReadonlySet<string> | null = null;
	#known: ReadonlySet<string> = new Set();

	observe(executors: readonly ExecutorSnapshot[]): boolean {
		const ready = new Set(
			executors
				.filter((executor) => executor.enabled && executor.availability === 'ready')
				.map((executor) => JSON.stringify([executor.id, executor.instanceId])),
		);
		const known = new Set(executors.map((executor) => executor.id));
		const previousReady = this.#ready;
		const removed = [...this.#known].some((id) => !known.has(id));
		this.#ready = ready;
		this.#known = known;
		if (previousReady === null) return false;
		return removed || [...ready].some((key) => !previousReady.has(key));
	}
}
