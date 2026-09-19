import type { RemoteSettingsSnapshot, RemotePathSettings } from '$shared/settings';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { effectiveNodeId } from '$shared/execution-nodes';
import {
	nextPinnedProjectPaths,
	sortedPinnedProjectPaths,
} from '$lib/chat/project-paths/project-pinned-paths.js';

interface PinnedProjectPathUpdateOptions {
	nodeId?: string;
	browseStartPath?: string;
}

function buildPathsPatch(
	pinnedProjectPaths: string[],
	options: PinnedProjectPathUpdateOptions = {},
): Partial<RemotePathSettings> {
	const patch: Partial<RemotePathSettings> = {
		pinnedProjectPaths: sortedPinnedProjectPaths(pinnedProjectPaths),
	};
	if (options.browseStartPath !== undefined) {
		patch.browseStartPath = options.browseStartPath;
	}
	return patch;
}

async function persistPinnedProjectPathsOptimistically(
	remoteSettings: RemoteSettingsStore,
	snap: RemoteSettingsSnapshot,
	pinnedProjectPaths: string[],
	options?: PinnedProjectPathUpdateOptions,
): Promise<RemoteSettingsSnapshot> {
	const nodeId = effectiveNodeId(options?.nodeId);
	const pathsPatch = nodeId === 'local' ? buildPathsPatch(pinnedProjectPaths, options) : {
		byNode: { ...snap.paths.byNode, [nodeId]: {
			...snap.paths.byNode?.[nodeId],
			recentPaths: snap.paths.byNode?.[nodeId]?.recentPaths ?? [],
			pinnedPaths: sortedPinnedProjectPaths(pinnedProjectPaths),
		} },
	};
	const rollback = remoteSettings.applyOptimisticSnapshot({
		...snap,
		paths: {
			...snap.paths,
			...pathsPatch,
		},
	});

	try {
		return await remoteSettings.update({ paths: pathsPatch });
	} catch (error) {
		rollback();
		throw error;
	}
}

export async function savePinnedProjectPathsOptimistically(
	remoteSettings: RemoteSettingsStore,
	pinnedProjectPaths: string[],
	options?: PinnedProjectPathUpdateOptions,
): Promise<RemoteSettingsSnapshot> {
	const snap = await remoteSettings.ensureLoaded();
	return persistPinnedProjectPathsOptimistically(remoteSettings, snap, pinnedProjectPaths, options);
}

export async function togglePinnedProjectPathOptimistically(
	remoteSettings: RemoteSettingsStore,
	path: string,
	options?: PinnedProjectPathUpdateOptions,
): Promise<RemoteSettingsSnapshot> {
	const snap = await remoteSettings.ensureLoaded();
	const nodeId = effectiveNodeId(options?.nodeId);
	const current = nodeId === 'local' ? snap.paths.pinnedProjectPaths : snap.paths.byNode?.[nodeId]?.pinnedPaths ?? [];
	const nextPinnedPaths = nextPinnedProjectPaths(current, path);
	return persistPinnedProjectPathsOptimistically(remoteSettings, snap, nextPinnedPaths, options);
}
