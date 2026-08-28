<script lang="ts">
	import { setWorkspaceCoordinator } from '$lib/context';
	import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
	import type { PaneId, WorkspaceLayoutSnapshot } from '$lib/workspace/surface-types.js';
	import WorkspaceFullscreenButton from '../WorkspaceFullscreenButton.svelte';

	let {
		host,
		fullscreenPaneId = null,
		onToggleFullscreen,
	}: {
		host: PaneId;
		fullscreenPaneId?: PaneId | null;
		onToggleFullscreen: (host: PaneId) => void;
	} = $props();

	type FullscreenWorkspacePort = {
		readonly layout: {
			readonly snapshot: Pick<WorkspaceLayoutSnapshot, 'fullscreenPaneId'>;
		};
		toggleFullscreen(host: PaneId): Promise<void>;
	};

	const workspace = {
		layout: {
			get snapshot() {
				return { fullscreenPaneId };
			},
		},
		async toggleFullscreen(nextHost: PaneId) {
			onToggleFullscreen(nextHost);
		},
	} satisfies FullscreenWorkspacePort;

	setWorkspaceCoordinator(workspace as WorkspaceCoordinator);
</script>

<WorkspaceFullscreenButton {host} />
