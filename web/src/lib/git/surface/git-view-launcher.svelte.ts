import type { GitComparisonDialogDefaults } from '$lib/git/review/git-comparison.svelte.js';
import type { GitTarget } from '$lib/git/targets/git-target.js';
import type { GitCompareLaunchIntent } from '$lib/git/review/git-compare-surface.svelte.js';
import {
	singletonSurfaceId,
	type HostId,
} from '$lib/workspace/surface-types.js';

export interface GitViewLaunchOrigin {
	presentation: HostId | 'mobile';
	source?: {
		effectiveProjectKey: string;
		target: GitTarget;
	};
}

export interface GitViewWorkspacePort {
	layout: {
		surface(surfaceId: string): unknown;
	};
	focusMobileSingleton(kind: 'git-history' | 'git-compare'): Promise<void>;
	openSingleton(
		kind: 'git-history' | 'git-compare',
		host: HostId,
	): Promise<void>;
}

export interface GitViewSurfacePort {
	gitCompare(): {
		prepareLaunch(intent: GitCompareLaunchIntent): number;
		cancelPreparedLaunch(token: number): void;
	};
	disposeSurface(kind: 'git-history' | 'git-compare'): void;
}

export class GitViewLauncher {
	constructor(
		private readonly workspace: GitViewWorkspacePort,
		private readonly surfaces: GitViewSurfacePort,
	) {}

	async openHistory(origin: GitViewLaunchOrigin): Promise<void> {
		const surfaceId = singletonSurfaceId('git-history');
		const existed = Boolean(this.workspace.layout.surface(surfaceId));
		try {
			if (origin.presentation === 'mobile') {
				await this.workspace.focusMobileSingleton('git-history');
			} else {
				await this.workspace.openSingleton('git-history', origin.presentation);
			}
		} catch (error) {
			if (!existed && !this.workspace.layout.surface(surfaceId)) {
				this.surfaces.disposeSurface('git-history');
			}
			throw error;
		}
	}

	async openCompare(
		origin: GitViewLaunchOrigin,
		comparison?: GitComparisonDialogDefaults,
	): Promise<void> {
		const surfaceId = singletonSurfaceId('git-compare');
		const existed = Boolean(this.workspace.layout.surface(surfaceId));
		const controller = this.surfaces.gitCompare();
		const launchToken =
			origin.source || comparison
				? controller.prepareLaunch({ source: origin.source, comparison })
				: null;
		try {
			if (origin.presentation === 'mobile') {
				await this.workspace.focusMobileSingleton('git-compare');
			} else {
				await this.workspace.openSingleton('git-compare', origin.presentation);
			}
		} catch (error) {
			if (launchToken !== null) controller.cancelPreparedLaunch(launchToken);
			if (!existed && !this.workspace.layout.surface(surfaceId)) {
				this.surfaces.disposeSurface('git-compare');
			}
			throw error;
		}
	}
}
