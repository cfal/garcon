<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import FileMentionMenu from '../FileMentionMenu.svelte';

	let props: ComponentProps<typeof FileMentionMenu> = $props();
	let menu: { handleKeyDown(event: KeyboardEvent): void };

	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));

	export function handleKeyDown(event: KeyboardEvent): void {
		menu.handleKeyDown(event);
	}
</script>

<FileMentionMenu bind:this={menu} {...props} />
