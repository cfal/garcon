import type { RecentAgentSetting, RemoteSettingsSnapshot } from '$shared/settings';
import { effectiveExecutorId } from '$shared/executors';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { SessionAgentId } from '$lib/types/app.js';

export function firstSelectableExecutorRecent(
	recents: readonly RecentAgentSetting[],
	executorId: string,
	selectableAgentIds: readonly SessionAgentId[],
	catalog: Pick<ModelCatalogStore, 'getModelForSelection'>,
): RecentAgentSetting | null {
	const selectable = new Set(selectableAgentIds);
	for (const recent of recents) {
		if (effectiveExecutorId(recent.executorId) !== executorId) continue;
		const agentId = recent.agentId as SessionAgentId;
		if (!selectable.has(agentId)) continue;
		if (catalog.getModelForSelection(agentId, recent.model, recent.modelEndpointId)) return recent;
	}
	return null;
}

export function newChatExecutorPreferences(
	snapshot: RemoteSettingsSnapshot | null,
	executorId: string,
	projectBasePath: string,
) {
	const paths = snapshot?.paths;
	if (executorId === 'local') {
		const browseStartPath = paths?.browseStartPath ?? '';
		return {
			pinnedProjectPaths: [...(paths?.pinnedProjectPaths ?? [])],
			browseStartPath,
			projectPath: paths?.recentProjectPaths[0] || browseStartPath || projectBasePath,
		};
	}

	const executorPaths = paths?.byExecutor?.[executorId];
	return {
		pinnedProjectPaths: [...(executorPaths?.pinnedPaths ?? [])],
		browseStartPath: '',
		projectPath: executorPaths?.defaultPath || executorPaths?.recentPaths[0] || projectBasePath,
	};
}
