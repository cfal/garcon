<script lang="ts">
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import type { GitRefOption, GitRefSort, GitRefSortKey } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';
	import GitBranchRefRow from './GitBranchRefRow.svelte';

	const REF_OPTION_ROW_HEIGHT = 36;
	const REF_OPTION_OVERSCAN = 8;

	interface Props {
		listboxId: string;
		refs: GitRefOption[];
		currentRef: string;
		query: string;
		sort: GitRefSort;
		isOpen: boolean;
		isLoading: boolean;
		onSelect: (ref: GitRefOption) => void;
		onSort: (key: GitRefSortKey) => void;
	}

	let { listboxId, refs, currentRef, query, sort, isOpen, isLoading, onSelect, onSort }: Props =
		$props();

	let viewportRef = $state<HTMLElement | null>(null);
	let currentTime = $derived.by(() => {
		refs;
		return new Date();
	});

	function filteredRefOptions(): GitRefOption[] {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) return refs;
		return refs.filter((ref) =>
			[ref?.name, ref?.ref, ref?.kind].some(
				(value) => typeof value === 'string' && value.toLowerCase().includes(normalizedQuery),
			),
		);
	}

	const virtualWindow = new FixedVirtualWindow({
		get itemCount() {
			return filteredRefOptions().length;
		},
		get rowHeight() {
			return REF_OPTION_ROW_HEIGHT;
		},
		get overscan() {
			return REF_OPTION_OVERSCAN;
		},
		get viewportRef() {
			return viewportRef;
		},
		defaultViewportHeight: 320,
	});

	function visibleRefRows(filteredRefs: GitRefOption[]): Array<{
		index: number;
		ref: GitRefOption;
	}> {
		return virtualWindow.visibleIndexes
			.map((index) => ({ index, ref: filteredRefs[index] }))
			.filter((entry): entry is { index: number; ref: GitRefOption } => Boolean(entry.ref));
	}

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	$effect(() => {
		return virtualWindow.observeViewport();
	});

	$effect(() => {
		isOpen;
		query;
		refs;
		if (!isOpen) return;
		const frame = requestAnimationFrame(() => {
			if (viewportRef) viewportRef.scrollTop = 0;
			virtualWindow.scrollTop = 0;
		});
		return () => cancelAnimationFrame(frame);
	});

	function nextSortLabel(key: GitRefSortKey): string {
		if (key === 'name') {
			const nextDirection = sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
			return nextDirection === 'asc'
				? m.git_branch_selector_sort_name_ascending()
				: m.git_branch_selector_sort_name_descending();
		}
		const nextDirection = sort.key === key && sort.direction === 'desc' ? 'asc' : 'desc';
		return nextDirection === 'desc'
			? m.git_branch_selector_sort_updated_descending()
			: m.git_branch_selector_sort_updated_ascending();
	}
</script>

{#snippet sortIcon(key: GitRefSortKey)}
	{#if sort.key === key}
		{#if sort.direction === 'asc'}
			<ChevronUp class="h-3 w-3 shrink-0" />
		{:else}
			<ChevronDown class="h-3 w-3 shrink-0" />
		{/if}
	{:else}
		<ArrowUpDown class="h-3 w-3 shrink-0 opacity-50" />
	{/if}
{/snippet}

{#snippet refRow(ref: GitRefOption, index: number)}
	{#key ref}
		<svelte:boundary>
			<GitBranchRefRow
				{ref}
				{currentRef}
				{currentTime}
				rowHeight={REF_OPTION_ROW_HEIGHT}
				offset={virtualWindow.getOffset(index)}
				{onSelect}
			/>
			{#snippet failed()}
				<button
					type="button"
					role="option"
					aria-selected="false"
					disabled
					class="absolute left-0 right-0 top-0 grid w-full grid-cols-[1rem_minmax(0,1fr)_5rem_4.5rem] items-center gap-2 px-3 text-left text-sm text-muted-foreground opacity-60"
					style={`height:${REF_OPTION_ROW_HEIGHT}px; transform:translateY(${virtualWindow.getOffset(index)}px);`}
					data-git-ref-virtual-row={`unavailable-${index}`}
				>
					<TriangleAlert class="h-3.5 w-3.5 text-status-warning-foreground" />
					<span class="truncate">{m.git_branch_selector_ref_unavailable()}</span>
					<span aria-hidden="true" class="text-right text-xs">—</span>
				</button>
			{/snippet}
		</svelte:boundary>
	{/key}
{/snippet}

{#snippet refListContent(filteredRefs: GitRefOption[])}
	{#if isLoading}
		<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-muted-foreground">
			<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
			<span>{m.status_loading()}</span>
		</div>
	{:else if filteredRefs.length === 0}
		<div class="px-3 py-3 text-center text-xs text-muted-foreground">
			{m.git_branch_selector_no_refs_found()}
		</div>
	{:else}
		<div
			class="relative"
			style={`height:${virtualWindow.totalHeight}px;`}
			data-git-ref-virtual-list
		>
			{#each visibleRefRows(filteredRefs) as entry (entry.index)}
				{@render refRow(entry.ref, entry.index)}
			{/each}
		</div>
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div
		role="group"
		aria-label={m.git_branch_selector_sort_refs()}
		class="grid h-8 shrink-0 grid-cols-[1rem_minmax(0,1fr)_5rem_4.5rem] items-center gap-2 overflow-y-auto border-b border-border px-3 text-xs text-muted-foreground"
		style:scrollbar-gutter="stable"
	>
		<span aria-hidden="true"></span>
		<button
			type="button"
			aria-pressed={sort.key === 'name'}
			aria-label={nextSortLabel('name')}
			onclick={() => onSort('name')}
			class="inline-flex min-w-0 items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span class="truncate">{m.git_branch_selector_name()}</span>
			{@render sortIcon('name')}
		</button>
		<button
			type="button"
			aria-pressed={sort.key === 'updated'}
			aria-label={nextSortLabel('updated')}
			aria-describedby={`${listboxId}-updated-description`}
			title={m.git_branch_selector_updated_explanation()}
			onclick={() => onSort('updated')}
			class="inline-flex items-center justify-end gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<span>{m.git_branch_selector_updated()}</span>
			{@render sortIcon('updated')}
		</button>
		<span class="truncate text-right">{m.git_branch_selector_ref_kind()}</span>
		<span id={`${listboxId}-updated-description`} class="sr-only">
			{m.git_branch_selector_updated_explanation()}
		</span>
	</div>

	<div
		bind:this={viewportRef}
		id={listboxId}
		class="min-h-0 flex-1 overflow-y-auto py-1"
		style:scrollbar-gutter="stable"
		role="listbox"
		aria-label={m.git_branch_selector_refs_label()}
		aria-busy={isLoading}
	>
		{@render refListContent(filteredRefOptions())}
	</div>
</div>
