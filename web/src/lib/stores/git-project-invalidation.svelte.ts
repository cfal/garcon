export class GitProjectInvalidationStore {
	versionByProject = $state<Record<string, number>>({});

	markChanged(projectPath: string): void {
		this.versionByProject = {
			...this.versionByProject,
			[projectPath]: (this.versionByProject[projectPath] ?? 0) + 1,
		};
	}

	version(projectPath: string | null): number {
		return projectPath ? (this.versionByProject[projectPath] ?? 0) : 0;
	}
}

export const gitProjectInvalidations = new GitProjectInvalidationStore();
