import type { RemoteSettingsSnapshot, RemotePathSettings, RemotePathSettingsPatch } from '$shared/settings';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { effectiveExecutorId } from '$shared/executors';
import { orderedProjectPaths, reconcileProjectPins } from '$shared/project-pins';
import { nextPinnedProjectPaths } from '$lib/project-paths/project-pinned-paths.js';

interface PinnedProjectPathUpdateOptions {
	executorId?: string;
	browseStartPath?: string;
}

export function executorPinnedProjectPaths(
	snapshot: RemoteSettingsSnapshot | null,
	executorId?: string | null,
): string[] {
	const id = effectiveExecutorId(executorId);
	const paths = snapshot?.paths;
	return (id === 'local' ? paths?.pinnedProjectPaths : paths?.byExecutor?.[id]?.pinnedPaths) ?? [];
}

function buildPathsPatch(
	pinnedProjectPaths: string[],
	options: PinnedProjectPathUpdateOptions = {},
): Partial<RemotePathSettings> {
	const patch: Partial<RemotePathSettings> = {
		pinnedProjectPaths: orderedProjectPaths(pinnedProjectPaths),
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
	const currentRecents = executorId === 'local'
		? snap.paths.recentProjectPaths
		: snap.paths.byExecutor?.[executorId]?.recentPaths;
	const { pinnedPaths, recentPaths } = reconcileProjectPins(
		executorPinnedProjectPaths(snap, executorId), pinnedProjectPaths, currentRecents,
	);
	const pathsPatch: RemotePathSettingsPatch = executorId === 'local'
		? buildPathsPatch(pinnedPaths, options)
		: { byExecutor: { [executorId]: { pinnedPaths } } };
	const rollback = remoteSettings.applyOptimisticSnapshot({
		...snap,
		paths: executorId === 'local' ? { ...snap.paths, ...buildPathsPatch(pinnedPaths, options), recentProjectPaths: recentPaths } : {
			...snap.paths,
			byExecutor: { ...snap.paths.byExecutor, [executorId]: {
				...snap.paths.byExecutor?.[executorId], recentPaths, pinnedPaths,
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
	const current = executorPinnedProjectPaths(snap, options?.executorId);
	const nextPinnedPaths = nextPinnedProjectPaths(current, path);
	return persistPinnedProjectPathsOptimistically(remoteSettings, snap, nextPinnedPaths, options);
}
