<script lang="ts">
	import { setAppShell, setExecutors, setTransientLayers } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import ExecutorsSection from '../ExecutorsSection.svelte';

	const shell = createAppShellStore();
	setAppShell(shell);
	setExecutors(new ExecutorsStore());
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<button onclick={() => shell.openSettings()}>Open executors</button>
{#if shell.showSettings}
	<Dialog.Root open={shell.showSettings} onOpenChange={(open) => { if (!open) shell.closeSettings(); }}>
		<Dialog.Content>
			<Dialog.Title>Server Settings</Dialog.Title>
			<ExecutorsSection />
		</Dialog.Content>
	</Dialog.Root>
{/if}
