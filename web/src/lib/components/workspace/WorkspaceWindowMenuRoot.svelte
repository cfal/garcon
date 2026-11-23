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

	// Keeps the portal owner through dismissal so Bits can finish focus restoration.
	let hasOpened = $state(false);

	function handleOpenChange(nextOpen: boolean): void {
		if (nextOpen) hasOpened = true;
		onOpenChange?.(nextOpen);
	}
</script>

<Root bind:open onOpenChange={handleOpenChange}>
	{@render trigger()}
	{#if hasOpened || open}
		{@render children()}
	{/if}
</Root>
