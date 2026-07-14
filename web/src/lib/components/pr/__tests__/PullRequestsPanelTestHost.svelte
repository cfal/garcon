<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setWorkspaceCoordinator } from '$lib/context';
	import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';
	import PullRequestsPanel from '../PullRequestsPanel.svelte';

	let { props }: { props: ComponentProps<typeof PullRequestsPanel> } = $props();

	setWorkspaceCoordinator({
		isSurfaceCloseBlocked: () => false,
		moveSurface: async () => undefined,
		closeSurface: async () => true,
		popOutFile: async () => undefined,
	} as unknown as WorkspaceCoordinator);
</script>

<PullRequestsPanel {...props} />
