<script lang="ts">
	import { setAppShell, setExecutionNodes, setTransientLayers } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import ExecutionNodesDialog from '../ExecutionNodesDialog.svelte';

	const shell = createAppShellStore();
	setAppShell(shell);
	setExecutionNodes(new ExecutionNodesStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<button onclick={() => shell.openExecutionNodes()}>Open execution nodes</button>
{#if shell.showExecutionNodes}<ExecutionNodesDialog />{/if}
