<script lang="ts">
	import { untrack } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import FileText from '@lucide/svelte/icons/file-text';
	import Search from '@lucide/svelte/icons/search';
	import type { GitCommitFileSummary } from '$lib/api/git.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitCommitChangedFileListProps {
		files: GitCommitFileSummary[];
		fileFilter: string;
		focusedFilePath: string | null;
		onFileFilterChange: (value: string) => void;
		onSelectFile: (filePath: string) => void;
	}

	let {
		files,
		fileFilter,
		focusedFilePath,
		onFileFilterChange,
		onSelectFile,
	}: GitCommitChangedFileListProps = $props();

	let listRef = $state<HTMLDivElement | null>(null);
	const rowHeight = 49;
	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => listRef,
		estimateSize: () => rowHeight,
		initialRect: { width: 288, height: 720 },
		overscan: 10,
		getItemKey: (index) => files[index]?.path ?? index,
	});
	let virtualItems = $derived($virtualizer.getVirtualItems());
	let renderedItems = $derived.by(() => {
		if (virtualItems.length > 0 || files.length === 0) return virtualItems;
		return files.slice(0, 20).map((file, index) => ({
			index,
			key: file.path,
			start: index * rowHeight,
			size: rowHeight,
			end: (index + 1) * rowHeight,
		}));
	});
	let totalHeight = $derived($virtualizer.getTotalSize());

	$effect(() => {
		const count = files.length;
		const scrollElement = listRef;
		untrack(() => {
			$virtualizer.setOptions({
				count,
				getScrollElement: () => scrollElement,
				estimateSize: () => rowHeight,
				initialRect: { width: 288, height: 720 },
				overscan: 10,
				getItemKey: (index) => files[index]?.path ?? index,
			});
		});
	});

	function statusLabel(status: GitCommitFileSummary['status']): string {
		switch (status) {
			case 'added':
				return 'A';
			case 'deleted':
				return 'D';
			case 'renamed':
				return 'R';
			case 'copied':
				return 'C';
			case 'type-changed':
				return 'T';
			case 'modified':
				return 'M';
			default:
				return '?';
		}
	}
</script>

<aside class="flex min-h-0 flex-1 flex-col bg-background">
	<div class="border-b border-border p-2">
		<div class="relative">
			<Search
				class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="search"
				class="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				placeholder={m.git_history_filter_files()}
				value={fileFilter}
				oninput={(event) => onFileFilterChange(event.currentTarget.value)}
			/>
		</div>
	</div>
	<div bind:this={listRef} class="min-h-0 flex-1 overflow-y-auto" data-git-file-list-virtual-root>
		{#if files.length === 0}
			<div class="px-3 py-5 text-xs text-muted-foreground">{m.git_history_no_filter_matches()}</div>
		{:else}
			<div class="relative w-full" style:height={`${totalHeight}px`}>
				{#each renderedItems as virtualItem (virtualItem.key)}
					{@const file = files[virtualItem.index]}
					{#if file}
						<button
							type="button"
							class="absolute left-0 top-0 flex w-full min-w-0 items-start gap-2 overflow-hidden border-b border-border/60 px-2 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent {focusedFilePath ===
							file.path
								? 'bg-muted/60'
								: ''}"
							style:height={`${virtualItem.size}px`}
							style:transform={`translateY(${virtualItem.start}px)`}
							data-git-file-list-row
							onclick={() => onSelectFile(file.path)}
						>
							<span
								class="mt-0.5 w-5 shrink-0 rounded bg-muted px-1 py-0.5 text-center text-[10px] text-muted-foreground"
								>{statusLabel(file.status)}</span
							>
							<FileText class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
							<span class="min-w-0 flex-1">
								<span class="block truncate font-mono text-xs text-foreground" title={file.path}
									>{file.path}</span
								>
								{#if file.originalPath}
									<span
										class="block truncate text-[10px] text-muted-foreground"
										title={file.originalPath}
										>{m.git_history_renamed_from({ path: file.originalPath })}</span
									>
								{/if}
							</span>
							<span class="shrink-0 text-[10px] text-git-added"
								>+{file.statsKnown === false ? '?' : file.additions}</span
							>
							<span class="shrink-0 text-[10px] text-git-deleted"
								>-{file.statsKnown === false ? '?' : file.deletions}</span
							>
						</button>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</aside>
