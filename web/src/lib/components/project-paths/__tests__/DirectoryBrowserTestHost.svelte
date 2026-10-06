<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import { setExecutors, setTransientLayers } from '$lib/context';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import DirectoryBrowser from '$lib/components/project-paths/DirectoryBrowser.svelte';
	import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
	let {
		executors,
		localDirectoryCreation = true,
		...props
	}: ComponentProps<typeof DirectoryBrowser> & {
		/** Replaces the default inventory of Local and one ready worker. */
		executors?: ExecutorsStore;
		/** Applies to the default inventory only. */
		localDirectoryCreation?: boolean;
	} = $props();

	function defaultExecutors(): ExecutorsStore {
		const services = localExecutor.machineServices;
		const store = new ExecutorsStore();
		store.applySnapshot([
			{ ...localExecutor, machineServices: { ...services, directoryCreation: localDirectoryCreation } },
			{ ...remoteExecutor, machineServices: { ...services } },
		]);
		return store;
	}

	setExecutors(untrack(() => executors ?? defaultExecutors()));
	const executorId = $derived(props.executorId);
	const executorContextKey = $derived(props.executorContextKey);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<DirectoryBrowser {...props} {executorId} {executorContextKey} />
