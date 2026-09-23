<script lang="ts">
	import { setAppShell, setExecutionNodes, setTransientLayers } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import ExecutionNodesSection from '../ExecutionNodesSection.svelte';

	const shell = createAppShellStore();
	setAppShell(shell);
	setExecutionNodes(new ExecutionNodesStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<button onclick={() => shell.openSettings()}>Open execution nodes</button>
{#if shell.showSettings}
	<Dialog.Root open={shell.showSettings} onOpenChange={(open) => { if (!open) shell.closeSettings(); }}>
		<Dialog.Content>
			<Dialog.Title>Server Settings</Dialog.Title>
			<ExecutionNodesSection />
		</Dialog.Content>
	</Dialog.Root>
{/if}
