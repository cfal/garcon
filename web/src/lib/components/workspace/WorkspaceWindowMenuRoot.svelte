<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ContextMenu } from '$lib/components/ui/context-menu';
	import type { DropdownMenu } from '$lib/components/ui/dropdown-menu';

	let {
		root: Root,
		open = $bindable(false),
		onOpenChange,
		trigger,
		children,
	}: {
		root: typeof ContextMenu | typeof DropdownMenu;
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		trigger: Snippet;
		children: Snippet;
	} = $props();

	// Keeps the portal owner until Bits completes the exit.
	let exitingOrOpen = $state(false);

	$effect.pre(() => {
		if (open) exitingOrOpen = true;
	});
</script>

<Root
	bind:open
	{onOpenChange}
	onOpenChangeComplete={(nextOpen) => {
		if (!nextOpen && !open) exitingOrOpen = false;
	}}
>
	{@render trigger()}
	{#if exitingOrOpen || open}
		{@render children()}
	{/if}
</Root>
