<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import ModelSelectorPopover from './ModelSelectorPopover.svelte';

	let {
		picker = $bindable(),
		mode,
		...props
	}: Omit<ComponentProps<typeof ModelSelectorPopover>, 'contentClass'> & {
		picker?: ModelSelectorPopover;
	} = $props();
</script>

<ModelSelectorPopover
	bind:this={picker}
	{...props}
	mode={{ ...mode, executor: 'fixed', surface: 'composer' }}
/>
