<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setExecutionNodesTestContext } from '$lib/execution-nodes/__tests__/execution-nodes-test-context.js';
	import CommitSurface from '../CommitSurface.svelte';
	import { setRemoteSettings, setTransientLayers, setWorkspaceCoordinator } from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';

	let props: ComponentProps<typeof CommitSurface> = $props();
	setExecutionNodesTestContext();
	setRemoteSettings(createRemoteSettingsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
	setWorkspaceCoordinator({
		moveSurface: () => Promise.resolve(),
		closeSurface: () => Promise.resolve(true),
		isSurfaceCloseBlocked: () => false,
	} as never);
</script>

<CommitSurface {...props} />
