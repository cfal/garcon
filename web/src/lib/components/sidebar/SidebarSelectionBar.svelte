<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { Button } from '$lib/components/ui/button';
	import Pin from '@lucide/svelte/icons/pin';
	import Archive from '@lucide/svelte/icons/archive';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Check from '@lucide/svelte/icons/check';

	interface SidebarSelectionBarProps {
		count: number;
		totalVisible: number;
		showPin: boolean;
		showUnpin: boolean;
		showArchive: boolean;
		showUnarchive: boolean;
		isOperating: boolean;
		onSelectAll: () => void;
		onDeselectAll: () => void;
		onPin: () => void;
		onUnpin: () => void;
		onArchive: () => void;
		onUnarchive: () => void;
		onDelete: () => void;
		onDone: () => void;
	}

	let {
		count,
		totalVisible,
		showPin,
		showUnpin,
		showArchive,
		showUnarchive,
		isOperating,
		onSelectAll,
		onDeselectAll,
		onPin,
		onUnpin,
		onArchive,
		onUnarchive,
		onDelete,
		onDone,
	}: SidebarSelectionBarProps = $props();

	let allSelected = $derived(count > 0 && count === totalVisible);
</script>

<div
	class={cn(
		'absolute inset-x-0 bottom-0 z-40',
		'bg-card/95 backdrop-blur-sm border-t border-border',
		'px-3 py-2 flex flex-col gap-1.5',
		'shadow-[0_-2px_8px_rgba(0,0,0,0.08)]',
		'animate-in slide-in-from-bottom-2 duration-200',
	)}
>
	<!-- Top row: count + select/deselect + done -->
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 min-w-0">
			<span class="text-xs font-medium text-foreground tabular-nums whitespace-nowrap">
				{m.sidebar_select_count({ count })}
			</span>
			<button
				type="button"
				class="text-xs text-primary hover:text-primary/80 transition-colors font-medium whitespace-nowrap"
				onclick={allSelected ? onDeselectAll : onSelectAll}
				disabled={isOperating}
			>
				{allSelected ? m.sidebar_select_none() : m.sidebar_select_all()}
			</button>
		</div>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 px-2.5 text-xs font-medium gap-1"
			onclick={onDone}
			disabled={isOperating}
		>
			<Check class="size-3.5" />
			{m.sidebar_select_done()}
		</Button>
	</div>

	<!-- Bottom row: action buttons -->
	<div class="flex items-center gap-1">
		{#if showPin}
			<Button
				variant="ghost"
				size="sm"
				class="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
				onclick={onPin}
				disabled={isOperating || count === 0}
			>
				<Pin class="size-3.5" />
				{m.sidebar_select_pin()}
			</Button>
		{/if}
		{#if showUnpin}
			<Button
				variant="ghost"
				size="sm"
				class="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
				onclick={onUnpin}
				disabled={isOperating || count === 0}
			>
				<Pin class="size-3.5" />
				{m.sidebar_select_unpin()}
			</Button>
		{/if}
		{#if showArchive}
			<Button
				variant="ghost"
				size="sm"
				class="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
				onclick={onArchive}
				disabled={isOperating || count === 0}
			>
				<Archive class="size-3.5" />
				{m.sidebar_select_archive()}
			</Button>
		{/if}
		{#if showUnarchive}
			<Button
				variant="ghost"
				size="sm"
				class="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
				onclick={onUnarchive}
				disabled={isOperating || count === 0}
			>
				<Archive class="size-3.5" />
				{m.sidebar_select_unarchive()}
			</Button>
		{/if}
		<div class="flex-1"></div>
		<Button
			variant="ghost"
			size="sm"
			class="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
			onclick={onDelete}
			disabled={isOperating || count === 0}
		>
			<Trash2 class="size-3.5" />
			{m.sidebar_select_delete()}
		</Button>
	</div>
</div>
