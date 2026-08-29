<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import SlashCommandMenu from '../SlashCommandMenu.svelte';

	let props: ComponentProps<typeof SlashCommandMenu> = $props();
	let menu: { handleKeyDown(event: KeyboardEvent): boolean };

	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));

	export function handleKeyDown(event: KeyboardEvent): boolean {
		return menu.handleKeyDown(event);
	}
</script>

<SlashCommandMenu bind:this={menu} {...props} />
