<script lang="ts">
	import { setWorkspaceCoordinator } from '$lib/context';
	import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
	import type { HostId, WorkspaceLayoutSnapshot } from '$lib/workspace/surface-types.js';
	import WorkspaceFullscreenButton from '../WorkspaceFullscreenButton.svelte';

	let {
		host,
		fullscreenHost = null,
		onToggleFullscreen,
	}: {
		host: HostId;
		fullscreenHost?: HostId | null;
		onToggleFullscreen: (host: HostId) => void;
	} = $props();

	type FullscreenWorkspacePort = {
		readonly layout: {
			readonly snapshot: Pick<WorkspaceLayoutSnapshot, 'fullscreenHost'>;
		};
		toggleFullscreen(host: HostId): Promise<void>;
	};

	const workspace = {
		layout: {
			get snapshot() {
				return { fullscreenHost };
			},
		},
		async toggleFullscreen(nextHost: HostId) {
			onToggleFullscreen(nextHost);
		},
	} satisfies FullscreenWorkspacePort;

	setWorkspaceCoordinator(workspace as WorkspaceCoordinator);
</script>

<WorkspaceFullscreenButton {host} />
