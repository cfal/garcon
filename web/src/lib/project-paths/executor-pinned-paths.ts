import type { ExecutorSnapshot } from '$shared/executors';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import { sortedPinnedProjectPaths } from './project-pinned-paths';

export interface ExecutorPinnedPathGroup {
	executorId: string;
	paths: string[];
}

export function executorPinnedPathGroups(
	paths: RemoteSettingsSnapshot['paths'] | undefined,
	executors: readonly ExecutorSnapshot[],
	selectedExecutorId: string,
	selectedPins: string[],
): ExecutorPinnedPathGroup[] {
	const ids = new Set([
		'local',
		...executors.map((executor) => executor.id),
		...Object.keys(paths?.byExecutor ?? {}),
		selectedExecutorId,
	]);
	return [...ids]
		.map((executorId) => ({
			executorId,
			paths: sortedPinnedProjectPaths(
				executorId === selectedExecutorId
					? selectedPins
					: executorId === 'local'
						? (paths?.pinnedProjectPaths ?? [])
						: (paths?.byExecutor?.[executorId]?.pinnedPaths ?? []),
			),
		}))
		.filter((group) => group.paths.length > 0);
}
