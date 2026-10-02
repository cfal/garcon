import { singletonSurfaceId, type WorkspaceWindowId } from '$lib/workspace/surface-types.js';

export interface GitViewLaunchOrigin {
	presentation: WorkspaceWindowId | 'mobile';
}

export interface GitViewWorkspacePort {
	layout: {
		surface(surfaceId: string): unknown;
	};
	focusMobileSingleton(kind: 'git-history' | 'git-compare'): Promise<void>;
	openSingletonAsTab(
		kind: 'git-history' | 'git-compare',
		windowId: WorkspaceWindowId,
	): Promise<void>;
}

export interface GitViewSurfacePort {
	disposeSurface(kind: 'git-history' | 'git-compare'): void;
}

export class GitViewLauncher {
	constructor(
		private readonly workspace: GitViewWorkspacePort,
		private readonly surfaces: GitViewSurfacePort,
	) {}

	openHistory(origin: GitViewLaunchOrigin): Promise<void> {
		return this.#open('git-history', origin);
	}

	openCompare(origin: GitViewLaunchOrigin): Promise<void> {
		return this.#open('git-compare', origin);
	}

	async #open(kind: 'git-history' | 'git-compare', origin: GitViewLaunchOrigin): Promise<void> {
		const surfaceId = singletonSurfaceId(kind);
		const existed = Boolean(this.workspace.layout.surface(surfaceId));
		try {
			if (origin.presentation === 'mobile') {
				await this.workspace.focusMobileSingleton(kind);
			} else {
				await this.workspace.openSingletonAsTab(kind, origin.presentation);
			}
		} catch (error) {
			if (!existed && !this.workspace.layout.surface(surfaceId)) {
				this.surfaces.disposeSurface(kind);
			}
			throw error;
		}
	}
}
