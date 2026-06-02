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
			class="selection-action-button h-7 px-2.5 text-xs font-medium gap-1"
			onclick={onDone}
			disabled={isOperating}
			aria-label={m.sidebar_select_done()}
			title={m.sidebar_select_done()}
		>
			<Check class="size-3.5 shrink-0" />
			<span class="selection-action-label">{m.sidebar_select_done()}</span>
		</Button>
	</div>

	<!-- Bottom row: action buttons -->
	<div class="selection-action-row flex items-center gap-1">
		{#if showPin}
			<Button
				variant="ghost"
				size="sm"
				class="selection-action-button h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
				onclick={onPin}
				disabled={isOperating || count === 0}
				aria-label={m.sidebar_select_pin()}
				title={m.sidebar_select_pin()}
			>
				<Pin class="size-3.5 shrink-0" />
				<span class="selection-action-label">{m.sidebar_select_pin()}</span>
			</Button>
		{/if}
		{#if showUnpin}
			<Button
				variant="ghost"
				size="sm"
				class="selection-action-button h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
				onclick={onUnpin}
				disabled={isOperating || count === 0}
				aria-label={m.sidebar_select_unpin()}
				title={m.sidebar_select_unpin()}
			>
				<Pin class="size-3.5 shrink-0" />
				<span class="selection-action-label">{m.sidebar_select_unpin()}</span>
			</Button>
		{/if}
		{#if showArchive}
			<Button
				variant="ghost"
				size="sm"
				class="selection-action-button h-7 px-2 text-xs gap-1 text-sidebar-bulk-archive-foreground hover:text-sidebar-bulk-archive-foreground hover:bg-sidebar-bulk-archive-bg"
				onclick={onArchive}
				disabled={isOperating || count === 0}
				aria-label={m.sidebar_select_archive()}
				title={m.sidebar_select_archive()}
			>
				<Archive class="size-3.5 shrink-0" />
				<span class="selection-action-label">{m.sidebar_select_archive()}</span>
			</Button>
		{/if}
		{#if showUnarchive}
			<Button
				variant="ghost"
				size="sm"
				class="selection-action-button h-7 px-2 text-xs gap-1 text-sidebar-bulk-unarchive-foreground hover:text-sidebar-bulk-unarchive-foreground hover:bg-sidebar-bulk-unarchive-bg"
				onclick={onUnarchive}
				disabled={isOperating || count === 0}
				aria-label={m.sidebar_select_unarchive()}
				title={m.sidebar_select_unarchive()}
			>
				<Archive class="size-3.5 shrink-0" />
				<span class="selection-action-label">{m.sidebar_select_unarchive()}</span>
			</Button>
		{/if}
		<div class="flex-1"></div>
		<Button
			variant="ghost"
			size="sm"
			class="selection-action-button h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
			onclick={onDelete}
			disabled={isOperating || count === 0}
			aria-label={m.sidebar_select_delete()}
			title={m.sidebar_select_delete()}
		>
			<Trash2 class="size-3.5 shrink-0" />
			<span class="selection-action-label">{m.sidebar_select_delete()}</span>
		</Button>
	</div>
</div>

<style>
	:global(.selection-action-button) {
		flex: 0 0 auto;
	}

	:global(.selection-action-label) {
		white-space: nowrap;
	}

	.selection-action-row {
		container-type: inline-size;
	}

	@container (max-width: 24rem) {
		:global(.selection-action-row .selection-action-button) {
			width: 1.75rem;
			padding-inline: 0;
		}

		:global(.selection-action-row .selection-action-label) {
			display: none;
		}
	}
</style>
