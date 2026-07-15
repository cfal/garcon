<script lang="ts">
	import { onMount } from 'svelte';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Search from '@lucide/svelte/icons/search';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type { GitWorktreeItem } from '$lib/api/git.js';
	import { FixedVirtualWindow } from '$lib/components/virtual/fixed-virtual-window.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import GitWorktreePickerRow from './GitWorktreePickerRow.svelte';
	import {
		WORKTREE_LIST_DEFAULT_VIEWPORT_HEIGHT,
		WORKTREE_NARROW_MEDIA_QUERY,
		WORKTREE_ROW_HEIGHT_NARROW,
		WORKTREE_ROW_HEIGHT_WIDE,
		WORKTREE_ROW_OVERSCAN,
		WORKTREE_VIRTUALIZATION_THRESHOLD,
		worktreeOptionId,
	} from './git-worktree-picker-list.js';

	interface Props {
		listboxId: string;
		worktrees: GitWorktreeItem[];
		totalWorktreeCount: number;
		selectedIndex: number;
		selectedPath: string | undefined;
		isLoading: boolean;
		hasLoadError: boolean;
		onActivate: (worktreePath: string) => void;
		onSelect: (worktreePath: string) => void;
		onActiveOptionIdChange: (optionId: string | undefined) => void;
	}

	let {
		listboxId,
		worktrees,
		totalWorktreeCount,
		selectedIndex,
		selectedPath,
		isLoading,
		hasLoadError,
		onActivate,
		onSelect,
		onActiveOptionIdChange,
	}: Props = $props();

	let viewportRef = $state<HTMLElement | null>(null);
	let narrowRows = $state(
		typeof window !== 'undefined' &&
			typeof window.matchMedia === 'function' &&
			window.matchMedia(WORKTREE_NARROW_MEDIA_QUERY).matches,
	);
	const rootFontSize = (() => {
		if (typeof window === 'undefined') return 16;
		const value = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
		return Number.isFinite(value) && value > 0 ? value : 16;
	})();
	const rowHeightScale = Math.max(1, rootFontSize / 16);
	let rowHeight = $derived(
		(narrowRows ? WORKTREE_ROW_HEIGHT_NARROW : WORKTREE_ROW_HEIGHT_WIDE) * rowHeightScale,
	);
	let useVirtualRows = $derived(worktrees.length > WORKTREE_VIRTUALIZATION_THRESHOLD);
	let currentTime = $derived.by(() => {
		worktrees;
		return new Date();
	});

	const virtualWindow = new FixedVirtualWindow({
		get itemCount() {
			return worktrees.length;
		},
		get rowHeight() {
			return rowHeight;
		},
		get overscan() {
			return WORKTREE_ROW_OVERSCAN;
		},
		get viewportRef() {
			return viewportRef;
		},
		defaultViewportHeight: WORKTREE_LIST_DEFAULT_VIEWPORT_HEIGHT,
	});

	let visibleRows = $derived.by(() =>
		virtualWindow.visibleIndexes
			.map((index) => ({ index, worktree: worktrees[index] }))
			.filter((entry): entry is { index: number; worktree: GitWorktreeItem } =>
				Boolean(entry.worktree),
			),
	);
	let selectedIsMounted = $derived(
		!useVirtualRows || visibleRows.some((entry) => entry.index === selectedIndex),
	);
	let activeOptionId = $derived(
		!isLoading && selectedPath && selectedIsMounted
			? worktreeOptionId(listboxId, selectedPath)
			: undefined,
	);

	$effect(() => {
		return virtualWindow.bindViewport();
	});

	// Tracks browser-owned viewport metrics that cannot be derived from props.
	$effect(() => {
		return virtualWindow.observeViewport();
	});

	$effect(() => {
		onActiveOptionIdChange(activeOptionId);
	});

	$effect(() => {
		worktrees;
		const index = selectedIndex;
		const busy = isLoading;
		const viewportHeight = virtualWindow.viewportHeight;
		const virtualized = useVirtualRows;
		const viewport = viewportRef;
		const frame = requestAnimationFrame(() => {
			if (busy || index < 0) return;
			if (virtualized) {
				virtualWindow.scrollIndexIntoViewNearest(index);
				return;
			}
			viewport
				?.querySelector<HTMLElement>(`[data-worktree-index="${index}"]`)
				?.scrollIntoView({ block: 'nearest' });
		});
		void viewportHeight;
		return () => cancelAnimationFrame(frame);
	});

	onMount(() => {
		if (typeof window.matchMedia !== 'function') return;
		const media = window.matchMedia(WORKTREE_NARROW_MEDIA_QUERY);
		let frame: number | null = null;
		let pendingAnchor: { index: number; ratio: number } | null = null;
		const update = () => {
			if (narrowRows === media.matches) return;
			if (!pendingAnchor) {
				const previousHeight = virtualWindow.rowHeight;
				const previousTop = virtualWindow.scrollTop;
				pendingAnchor = {
					index: Math.floor(previousTop / previousHeight),
					ratio: (previousTop % previousHeight) / previousHeight,
				};
			}
			narrowRows = media.matches;
			if (frame !== null) cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = null;
				const anchor = pendingAnchor;
				pendingAnchor = null;
				if (!viewportRef || !anchor) return;
				const nextTop =
					anchor.index * virtualWindow.rowHeight + anchor.ratio * virtualWindow.rowHeight;
				viewportRef.scrollTop = nextTop;
				virtualWindow.scrollTop = viewportRef.scrollTop;
			});
		};
		update();
		media.addEventListener('change', update);
		return () => {
			if (frame !== null) cancelAnimationFrame(frame);
			media.removeEventListener('change', update);
		};
	});
</script>

{#snippet worktreeRow(worktree: GitWorktreeItem, index: number)}
	{#key worktree}
		<svelte:boundary>
			<GitWorktreePickerRow
				{worktree}
				{index}
				setSize={worktrees.length}
				{rowHeight}
				optionId={worktreeOptionId(listboxId, worktree.path)}
				isSelected={worktree.path === selectedPath}
				{currentTime}
				{onActivate}
				{onSelect}
			/>
			{#snippet failed()}
				<button
					id={worktreeOptionId(listboxId, worktree.path)}
					data-worktree-index={index}
					type="button"
					role="option"
					tabindex="-1"
					aria-selected={worktree.path === selectedPath}
					aria-posinset={index + 1}
					aria-setsize={worktrees.length}
					disabled={worktree.isPathMissing}
					style={`height:${rowHeight}px;`}
					onclick={() => onSelect(worktree.path)}
					onmousemove={() => onActivate(worktree.path)}
					class="flex min-w-0 w-full items-center gap-2 overflow-hidden rounded-md px-3 text-sm text-muted-foreground {worktree.isPathMissing
						? 'cursor-not-allowed opacity-40'
						: 'hover:bg-accent/50'}"
				>
					<TriangleAlert class="h-4 w-4 shrink-0 text-destructive" />
					<span class="truncate">{m.workspace_worktree_row_unavailable()}</span>
				</button>
			{/snippet}
		</svelte:boundary>
	{/key}
{/snippet}

<div
	bind:this={viewportRef}
	id={listboxId}
	class="min-h-0 min-w-0 flex-1 overflow-y-auto p-1.5"
	role="listbox"
	aria-label={m.workspace_worktree_select()}
	aria-busy={isLoading}
	data-worktree-list-viewport
>
	{#if isLoading}
		<div class="flex items-center justify-center py-10">
			<LoaderCircle class="h-5 w-5 animate-spin text-muted-foreground" />
		</div>
	{:else if totalWorktreeCount === 0 && !hasLoadError}
		<div class="flex flex-col items-center justify-center gap-2 py-10">
			<GitBranch class="h-5 w-5 text-muted-foreground/50" />
			<span class="text-sm text-muted-foreground">No worktrees found</span>
		</div>
	{:else if totalWorktreeCount > 0 && worktrees.length === 0}
		<div class="flex flex-col items-center justify-center gap-2 py-10">
			<Search class="h-5 w-5 text-muted-foreground/50" />
			<span class="text-sm text-muted-foreground">
				{m.workspace_worktree_no_matches()}
			</span>
		</div>
	{:else if useVirtualRows}
		<div
			class="relative"
			style={`height:${virtualWindow.totalHeight}px;`}
			data-worktree-virtual-list
		>
			{#each visibleRows as entry (entry.worktree.path)}
				<div
					class="absolute left-0 right-0 top-0"
					style={`height:${rowHeight}px; transform:translateY(${virtualWindow.getOffset(entry.index)}px);`}
					data-worktree-virtual-row={entry.worktree.path}
				>
					{@render worktreeRow(entry.worktree, entry.index)}
				</div>
			{/each}
		</div>
	{:else}
		{#each worktrees as worktree, index (worktree.path)}
			{@render worktreeRow(worktree, index)}
		{/each}
	{/if}
</div>
