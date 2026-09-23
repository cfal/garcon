import type { RemoteSettingsSnapshot } from '$shared/settings';

export function newChatNodePreferences(
	snapshot: RemoteSettingsSnapshot | null,
	nodeId: string,
	projectBasePath: string,
) {
	const paths = snapshot?.paths;
	if (nodeId === 'local') {
		const browseStartPath = paths?.browseStartPath ?? '';
		return {
			pinnedProjectPaths: [...(paths?.pinnedProjectPaths ?? [])],
			browseStartPath,
			projectPath: paths?.recentProjectPaths[0] || browseStartPath || projectBasePath,
		};
	}

	const nodePaths = paths?.byNode?.[nodeId];
	return {
		pinnedProjectPaths: [...(nodePaths?.pinnedPaths ?? [])],
		browseStartPath: '',
		projectPath: nodePaths?.defaultPath || nodePaths?.recentPaths[0] || projectBasePath,
	};
}
