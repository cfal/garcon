<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import DirectoryBrowser from '$lib/components/project-paths/DirectoryBrowser.svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
	let {
		localDirectoryCreation = true,
		...props
	}: ComponentProps<typeof DirectoryBrowser> & { localDirectoryCreation?: boolean } = $props();
	setExecutorsTestContext([
		{
			...localExecutor,
			machineServices: {
				...localExecutor.machineServices,
				directoryCreation: untrack(() => localDirectoryCreation),
			},
		},
		{ ...remoteExecutor, machineServices: { ...localExecutor.machineServices } },
	]);
	const executorId = $derived(props.executorId);
	const executorContextKey = $derived(props.executorContextKey);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<DirectoryBrowser {...props} {executorId} {executorContextKey} />
