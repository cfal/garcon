import type { RemoteSettingsSnapshot, RemotePathSettings } from '$shared/settings';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import {
	nextPinnedProjectPaths,
	sortedPinnedProjectPaths,
} from '$lib/chat/project-paths/project-pinned-paths.js';

interface PinnedProjectPathUpdateOptions {
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
	const pathsPatch = buildPathsPatch(pinnedProjectPaths, options);
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
	const nextPinnedPaths = nextPinnedProjectPaths(snap.paths.pinnedProjectPaths, path);
	return persistPinnedProjectPathsOptimistically(remoteSettings, snap, nextPinnedPaths, options);
}
