export class GitProjectInvalidationStore {
	#versionByExecutor = $state<Record<string, number>>({});
	#revision = 0;

	markChanged(executorId: string): number {
		return (this.#versionByExecutor[executorId] = ++this.#revision);
	}

	version(executorId: string): number {
		return this.#versionByExecutor[executorId] ?? 0;
	}

	pruneExecutors(executorIds: ReadonlySet<string>): void {
		this.#versionByExecutor = Object.fromEntries(
			Object.entries(this.#versionByExecutor).filter(([executorId]) => executorIds.has(executorId)),
		);
	}
}

export const gitProjectInvalidations = new GitProjectInvalidationStore();
