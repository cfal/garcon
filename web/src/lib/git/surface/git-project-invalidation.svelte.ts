export class GitProjectInvalidationStore {
	#versionByNode = $state<Record<string, number>>({});
	#revision = 0;

	markChanged(nodeId: string): number {
		return (this.#versionByNode[nodeId] = ++this.#revision);
	}

	version(nodeId: string): number {
		return this.#versionByNode[nodeId] ?? 0;
	}

	pruneNodes(nodeIds: ReadonlySet<string>): void {
		this.#versionByNode = Object.fromEntries(
			Object.entries(this.#versionByNode).filter(([nodeId]) => nodeIds.has(nodeId)),
		);
	}
}

export const gitProjectInvalidations = new GitProjectInvalidationStore();
