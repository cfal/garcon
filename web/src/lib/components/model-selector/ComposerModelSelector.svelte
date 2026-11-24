<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';

	let { mode, ...props }: Omit<ComponentProps<typeof ModelSelectorPopover>, 'contentClass'> = $props();
	let picker = $state<ModelSelectorPopover>();
	export function menuSelection() {
		return picker?.menuSelection();
	}
	export function openPicker(): void {
		picker?.openPicker();
	}
	export function dismissPicker(): void {
		picker?.dismissPicker();
	}
</script>

<ModelSelectorPopover
	bind:this={picker}
	{...props}
	mode={{ ...mode, executor: 'fixed', surface: 'composer' }}
/>
