<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import { setTransientLayers } from '$lib/context';
	import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import FileMentionMenu from '../FileMentionMenu.svelte';

	let props: ComponentProps<typeof FileMentionMenu> = $props();
	let menu: { handleKeyDown(event: KeyboardEvent): void };

	setTransientLayers(new TransientLayerRegistry(new ChatInteractionGate()));

	export function handleKeyDown(event: KeyboardEvent): void {
		menu.handleKeyDown(event);
	}
</script>

<FileMentionMenu bind:this={menu} {...props} />
