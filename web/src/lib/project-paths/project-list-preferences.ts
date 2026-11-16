import type { RemoteSettingsSnapshot } from '$shared/settings';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { projectPathKey } from '$shared/project-path-preferences';
import { removeProjectPathFromList } from '$lib/api/settings.js';

export async function removeProjectPathFromListOptimistically(
	remoteSettings: RemoteSettingsStore,
	path: string,
	options: { executorId: string },
): Promise<RemoteSettingsSnapshot> {
	const executorId = options.executorId;
	const targetKey = projectPathKey(path);
	const snapshot = await remoteSettings.ensureLoaded();
	const owner = executorId === 'local'
		? { pinnedPaths: snapshot.paths.pinnedProjectPaths, recentPaths: snapshot.paths.recentProjectPaths }
		: snapshot.paths.byExecutor?.[executorId] ?? { pinnedPaths: [], recentPaths: [] };
	const pinnedPaths = owner.pinnedPaths.filter(candidate => projectPathKey(candidate) !== targetKey);
	const recentPaths = owner.recentPaths.filter(candidate => projectPathKey(candidate) !== targetKey);
	const rollback = remoteSettings.applyOptimisticSnapshot({
		...snapshot,
		paths: executorId === 'local'
			? { ...snapshot.paths, pinnedProjectPaths: pinnedPaths, recentProjectPaths: recentPaths }
			: { ...snapshot.paths, byExecutor: {
				...snapshot.paths.byExecutor, [executorId]: { ...owner, pinnedPaths, recentPaths },
			} },
	});
	try {
		const response = await removeProjectPathFromList({ executorId, projectPath: path });
		return remoteSettings.applySnapshot(response.settings);
	} catch (error) {
		rollback();
		throw error;
	}
}
