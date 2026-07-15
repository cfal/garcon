<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import File from '@lucide/svelte/icons/file';
	import FileCode2 from '@lucide/svelte/icons/file-code-2';
	import FileImage from '@lucide/svelte/icons/file-image';
	import FileText from '@lucide/svelte/icons/file-text';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import type { FileTableRow } from '$lib/files/tree/file-tree-rows.js';
	import type { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
	import { isImageFilePath } from '$lib/utils/file-kind.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		row,
		store,
		ariaRowIndex,
		focused,
		selected,
		onActivate,
		onFocus,
		onKeydown,
	}: {
		row: FileTableRow;
		store: FileTreeStore;
		ariaRowIndex: number;
		focused: boolean;
		selected: boolean;
		onActivate: () => void;
		onFocus: () => void;
		onKeydown: (event: KeyboardEvent) => void;
	} = $props();

	const entry = $derived(row.entry);
	const expanded = $derived(store.expandedDirs.has(entry.path));

	function toggleDisclosure(event: MouseEvent): void {
		event.stopPropagation();
		store.toggleDirectory(entry.path);
		(event.currentTarget as HTMLElement).closest<HTMLElement>('[data-file-tree-row]')?.focus();
	}

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
		const value = bytes / 1024 ** unitIndex;
		return `${Number(value.toFixed(1))} ${units[unitIndex]}`;
	}

	function formatRelativeTime(value: string | null): string {
		if (!value) return '-';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		let remaining = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
		if (remaining < 60) return m.filetree_just_now();
		remaining = Math.floor(remaining / 60);
		if (remaining < 60) return m.filetree_min_ago({ count: remaining });
		remaining = Math.floor(remaining / 60);
		if (remaining < 24) return m.filetree_hours_ago({ count: remaining });
		remaining = Math.floor(remaining / 24);
		if (remaining < 30) return m.filetree_days_ago({ count: remaining });
		return date.toLocaleDateString();
	}

	function iconType(): 'code' | 'document' | 'image' | 'generic' {
		const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
		if (
			['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'php', 'rb', 'go', 'rs'].includes(
				extension,
			)
		) {
			return 'code';
		}
		if (['md', 'txt', 'doc', 'pdf'].includes(extension)) return 'document';
		if (isImageFilePath(entry.name)) return 'image';
		return 'generic';
	}
</script>

<div
	role="row"
	tabindex={focused ? 0 : -1}
	aria-level={row.level}
	aria-rowindex={ariaRowIndex}
	aria-expanded={entry.type === 'directory' ? expanded : undefined}
	aria-selected={selected}
	data-file-tree-row
	data-file-tree-row-key={row.key}
	data-file-tree-row-level={row.level}
	class={`file-tree-virtual-row-content relative grid min-w-0 cursor-default select-none items-center gap-2 overflow-hidden px-2 text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${selected ? 'bg-accent ring-1 ring-inset ring-ring/30' : ''}`}
	style={`grid-template-columns: ${store.columnGridTemplate}`}
	onclick={onActivate}
	onfocus={onFocus}
	onkeydown={onKeydown}
>
	<div
		role="rowheader"
		class="relative flex min-w-0 items-center overflow-hidden"
		style={`padding-left: ${(row.level - 1) * 16}px`}
		title={entry.path}
	>
		{#if row.level > 1}
			<div class="pointer-events-none absolute inset-y-0 left-0" aria-hidden="true">
				{#each Array(row.level - 1) as _, index}
					<span class="absolute inset-y-0 w-px bg-border/70" style={`left: ${index * 16 + 7}px`}
					></span>
				{/each}
			</div>
		{/if}
		{#if entry.type === 'directory'}
			<button
				type="button"
				tabindex="-1"
				class="file-tree-disclosure-slot relative z-10 inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				aria-label={expanded
					? m.filetree_collapse_directory({ name: entry.name })
					: m.filetree_expand_directory({ name: entry.name })}
				title={expanded
					? m.filetree_collapse_directory({ name: entry.name })
					: m.filetree_expand_directory({ name: entry.name })}
				onclick={toggleDisclosure}
				onkeydown={(event) => event.stopPropagation()}
			>
				{#if expanded}
					<ChevronDown class="h-3.5 w-3.5" />
				{:else}
					<ChevronRight class="h-3.5 w-3.5" />
				{/if}
			</button>
			{#if expanded}
				<FolderOpen class="mr-2 h-4 w-4 shrink-0 text-file-icon-folder" />
			{:else}
				<Folder class="mr-2 h-4 w-4 shrink-0 text-file-icon-folder" />
			{/if}
		{:else}
			<span class="file-tree-disclosure-slot shrink-0" aria-hidden="true"></span>
			{@const kind = iconType()}
			{#if kind === 'code'}
				<FileCode2 class="mr-2 h-4 w-4 shrink-0 text-file-icon-code" />
			{:else if kind === 'document'}
				<FileText class="mr-2 h-4 w-4 shrink-0 text-file-icon-doc" />
			{:else if kind === 'image'}
				<FileImage class="mr-2 h-4 w-4 shrink-0 text-file-icon-image" />
			{:else}
				<File class="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
			{/if}
		{/if}
		<span class="min-w-0 truncate">{entry.name}</span>
	</div>
	{#if store.visibleColumns.size}
		<div role="gridcell" class="truncate whitespace-nowrap text-muted-foreground">
			{entry.type === 'file' ? formatFileSize(entry.size) : '-'}
		</div>
	{/if}
	{#if store.visibleColumns.modified}
		<div
			role="gridcell"
			class="truncate whitespace-nowrap text-muted-foreground"
			title={formatRelativeTime(entry.modified)}
		>
			{formatRelativeTime(entry.modified)}
		</div>
	{/if}
	{#if store.visibleColumns.permissions}
		<div
			role="gridcell"
			class="truncate whitespace-nowrap font-mono text-muted-foreground"
			title={entry.permissionsRwx || '-'}
		>
			{entry.permissionsRwx || '-'}
		</div>
	{/if}
</div>
