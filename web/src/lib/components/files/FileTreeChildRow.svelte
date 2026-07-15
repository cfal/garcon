<script lang="ts">
	import AlertCircle from '@lucide/svelte/icons/alert-circle';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { FileTreeColumnKey } from '$lib/files/tree/file-tree.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		kind,
		rowKey = null,
		level,
		directoryName,
		columnGridTemplate,
		visibleColumnKeys,
		ariaRowIndex,
		focused = false,
		onFocus,
		onKeydown,
		onRetry,
	}: {
		kind: 'loading' | 'error';
		rowKey?: string | null;
		level: number;
		directoryName: string;
		columnGridTemplate: string;
		visibleColumnKeys: readonly FileTreeColumnKey[];
		ariaRowIndex: number;
		focused?: boolean;
		onFocus?: () => void;
		onKeydown?: (event: KeyboardEvent) => void;
		onRetry?: () => void;
	} = $props();

	function retryFromButton(event: MouseEvent): void {
		event.stopPropagation();
		onRetry?.();
	}
</script>

<div
	role="row"
	tabindex={kind === 'error' ? (focused ? 0 : -1) : undefined}
	aria-level={level}
	aria-rowindex={ariaRowIndex}
	aria-label={kind === 'error' ? m.filetree_directory_error({ name: directoryName }) : undefined}
	data-file-tree-row={kind === 'error' ? '' : undefined}
	data-file-tree-row-key={kind === 'error' ? rowKey : undefined}
	class={`file-tree-virtual-row-content grid items-center gap-2 overflow-hidden px-2 text-xs outline-none ${kind === 'error' ? 'cursor-default text-destructive hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring' : 'text-muted-foreground'}`}
	style={`grid-template-columns: ${columnGridTemplate}`}
	onclick={kind === 'error' ? onRetry : undefined}
	onfocus={onFocus}
	onkeydown={onKeydown}
>
	<div
		role="rowheader"
		class="flex min-w-0 items-center gap-2"
		style={`padding-left: calc(${(level - 1) * 16}px + var(--file-tree-disclosure-size))`}
	>
		{#if kind === 'loading'}
			<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
			<span role="status" class="truncate">
				{m.filetree_loading_directory({ name: directoryName })}
			</span>
		{:else}
			<AlertCircle class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
			<span class="truncate">{m.filetree_directory_error({ name: directoryName })}</span>
			<button
				type="button"
				tabindex="-1"
				class="ml-auto rounded-sm px-2 py-1 hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={retryFromButton}
			>
				{m.filetree_retry()}
			</button>
		{/if}
	</div>
	{#each visibleColumnKeys.slice(1) as column (column)}
		<div role="gridcell"></div>
	{/each}
</div>
