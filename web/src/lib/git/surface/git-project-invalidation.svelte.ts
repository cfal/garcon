export class GitProjectInvalidationStore {
	versionByProject = $state<Record<string, number>>({});
	#revision = 0;

	markChanged(nodeId: string, projectPath: string): number {
		const key = JSON.stringify([nodeId, projectPath]);
		this.versionByProject = {
			...this.versionByProject,
			[key]: ++this.#revision,
		};
		return this.#revision;
	}

	version(nodeId: string, projectPath: string | null): number {
		if (!projectPath) return 0;
		let version = 0;
		for (const [key, revision] of Object.entries(this.versionByProject)) {
			const [changedNode, changedPath] = JSON.parse(key) as [string, string];
			if (
				changedNode === nodeId &&
				(containsPath(changedPath, projectPath) || containsPath(projectPath, changedPath))
			)
				version = Math.max(version, revision);
		}
		return version;
	}

	pruneNodes(nodeIds: ReadonlySet<string>): void {
		this.versionByProject = Object.fromEntries(
			Object.entries(this.versionByProject).filter(([key]) => nodeIds.has(JSON.parse(key)[0])),
		);
	}
}

export const gitProjectInvalidations = new GitProjectInvalidationStore();

function containsPath(root: string, path: string): boolean {
	return path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
}
