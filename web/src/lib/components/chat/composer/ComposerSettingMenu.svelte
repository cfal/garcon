<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import ComposerSettingSubmenu from '$lib/components/shared/ComposerSettingSubmenu.svelte';
	import type { ComposerControlPlacement } from './composer-toolbar-types';

	let {
		id,
		label,
		value,
		icon,
		children,
		placement,
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
		placement: ComposerControlPlacement;
		align: 'start' | 'end';
		side: 'top' | 'bottom';
		disabled?: boolean;
		tone?: string;
		triggerSlot?: string;
		rainbow?: boolean;
		onOpenAutoFocus?: (event: Event) => void;
	} = $props();
	const name = $derived(value ? `${label}: ${value}` : label);
	let open = $state(false);
	$effect.pre(() => {
		if (placement === 'hidden') open = false;
	});
</script>

{#if placement === 'menu'}
	<ComposerSettingSubmenu
		{id} {name} {label} {value} {icon} {children} {disabled} {align} {side} {onOpenAutoFocus} contentClass="w-64"
	/>
{:else}
	<DropdownMenu bind:open>
		<DropdownMenuTrigger
			hidden={placement === 'hidden'}
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
		<DropdownMenuContent
			{align}
			{side}
			{onOpenAutoFocus}
			onCloseAutoFocus={(event) => {
				if (placement === 'hidden') event.preventDefault();
			}}
			class="w-64 max-w-[calc(100vw-1rem)]"
		>
			{@render children()}
		</DropdownMenuContent>
	</DropdownMenu>
{/if}
