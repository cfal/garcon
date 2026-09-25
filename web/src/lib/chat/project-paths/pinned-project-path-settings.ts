import type { RemoteSettingsSnapshot, RemotePathSettings, RemotePathSettingsPatch } from '$shared/settings';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { effectiveExecutorId } from '$shared/executors';
import {
	nextPinnedProjectPaths,
	sortedPinnedProjectPaths,
} from '$lib/chat/project-paths/project-pinned-paths.js';

interface PinnedProjectPathUpdateOptions {
	executorId?: string;
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
	const executorId = effectiveExecutorId(options?.executorId);
	const pinnedPaths = sortedPinnedProjectPaths(pinnedProjectPaths);
	const pathsPatch: RemotePathSettingsPatch = executorId === 'local'
		? buildPathsPatch(pinnedPaths, options)
		: { byExecutor: { [executorId]: { pinnedPaths } } };
	const rollback = remoteSettings.applyOptimisticSnapshot({
		...snap,
		paths: executorId === 'local' ? { ...snap.paths, ...buildPathsPatch(pinnedPaths, options) } : {
			...snap.paths,
			byExecutor: { ...snap.paths.byExecutor, [executorId]: {
				recentPaths: [], ...snap.paths.byExecutor?.[executorId], pinnedPaths,
			} },
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
	const executorId = effectiveExecutorId(options?.executorId);
	const current = executorId === 'local' ? snap.paths.pinnedProjectPaths : snap.paths.byExecutor?.[executorId]?.pinnedPaths ?? [];
	const nextPinnedPaths = nextPinnedProjectPaths(current, path);
	return persistPinnedProjectPathsOptimistically(remoteSettings, snap, nextPinnedPaths, options);
}
