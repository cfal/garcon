<script lang="ts">
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
		DropdownMenuSub,
		DropdownMenuSubContent,
		DropdownMenuSubTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import MenuValueLabel from '$lib/components/shared/MenuValueLabel.svelte';

	let {
		id,
		label,
		value,
		icon,
		children,
		overflow,
		align,
		side,
		disabled = false,
		tone = '',
		triggerSlot,
		rainbow,
		onOpenAutoFocus,
	}: {
		id: string;
		label: string;
		value: string;
		icon: Snippet;
		children: Snippet;
		overflow: boolean;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
		disabled?: boolean;
		tone?: string;
		triggerSlot?: string;
		rainbow?: boolean;
		onOpenAutoFocus?: (event: Event) => void;
	} = $props();
	const name = $derived(value ? `${label}: ${value}` : label);
	const narrowViewport = new MediaQuery('(max-width: 640px)');
</script>

{#if overflow}
	<DropdownMenuSub>
		<DropdownMenuSubTrigger
			{disabled}
			class="group"
			textValue={label}
			aria-label={name}
			data-composer-control={id}
		>
			{@render icon()}
			<MenuValueLabel {label} {value} />
		</DropdownMenuSubTrigger>
		<DropdownMenuSubContent
			{onOpenAutoFocus}
			side={narrowViewport.current ? side : 'right'}
			{align}
			collisionPadding={8}
			class="max-h-(--bits-dropdown-menu-content-available-height) w-64 max-w-[calc(100vw-1rem)] overflow-y-auto"
		>
			{@render children()}
		</DropdownMenuSubContent>
	</DropdownMenuSub>
{:else}
	<DropdownMenu>
		<DropdownMenuTrigger
			{disabled}
			aria-label={name}
			title={name}
			data-composer-control={id}
			data-slot={triggerSlot}
			data-rainbow={rainbow || undefined}
			class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 {tone}"
		>
			{@render icon()}
		</DropdownMenuTrigger>
		<DropdownMenuContent {align} {side} {onOpenAutoFocus} class="w-64 max-w-[calc(100vw-1rem)]">
			{@render children()}
		</DropdownMenuContent>
	</DropdownMenu>
{/if}
