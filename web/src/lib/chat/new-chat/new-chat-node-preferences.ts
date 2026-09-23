import type { RecentAgentSetting, RemoteSettingsSnapshot } from '$shared/settings';
import { effectiveNodeId } from '$shared/execution-nodes';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
import type { SessionAgentId } from '$lib/types/app.js';

export function firstSelectableNodeRecent(
	recents: readonly RecentAgentSetting[],
	nodeId: string,
	selectableAgentIds: readonly SessionAgentId[],
	catalog: Pick<ModelCatalogStore, 'getModelForSelection'>,
): RecentAgentSetting | null {
	const selectable = new Set(selectableAgentIds);
	for (const recent of recents) {
		if (effectiveNodeId(recent.nodeId) !== nodeId) continue;
		const agentId = recent.agentId as SessionAgentId;
		if (!selectable.has(agentId)) continue;
		if (catalog.getModelForSelection(agentId, recent.model, recent.modelEndpointId)) return recent;
	}
	return null;
}

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
