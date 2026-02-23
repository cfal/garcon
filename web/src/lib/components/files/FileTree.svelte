<script lang="ts">
	import { onDestroy } from 'svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Button } from '$lib/components/ui/button';
	import Input from '$lib/components/ui/input/input.svelte';
	import {
		Folder,
		FolderOpen,
		File,
		FileText,
		FileCode,
		Search,
		X,
		ArrowUpDown,
		ChevronUp,
		ChevronDown,
		RefreshCw
	} from '@lucide/svelte';
	import * as m from '$lib/paraglide/messages.js';
	import type { FileTreeNode } from '$lib/api/files';
	import FileTreeSettingsMenu from './FileTreeSettingsMenu.svelte';
	import { FileTreeStore, type SortKey } from '$lib/stores/file-tree.svelte.js';

	interface FileTreeProps {
		projectPath: string | null;
		chatId: string | null;
		selectedPath?: string | null;
		onFileSelect: (file: FileTreeNode) => void;
		onImageSelect?: (file: FileTreeNode) => void;
	}

	let { projectPath, chatId, selectedPath = null, onFileSelect, onImageSelect }: FileTreeProps = $props();

	const store = new FileTreeStore();

	$effect(() => {
		store.init(projectPath, chatId);
	});

	// Debounce search input into the store's debouncedQuery.
	$effect(() => {
		const q = store.searchInput.trim().toLowerCase();
		const t = setTimeout(() => {
			store.debouncedQuery = q;
		}, 150);
		return () => clearTimeout(t);
	});

	onDestroy(() => store.reset());

	// Display tree: sorted, filtered, and search-narrowed.
	let displayFiles = $derived.by(() => {
		const tree = store.buildTree(store.rootFiles);
		if (!store.debouncedQuery) return tree;
		return store.filterTree(tree, store.debouncedQuery);
	});

	function isImageFile(filename: string): boolean {
		const ext = filename.split('.').pop()?.toLowerCase() ?? '';
		return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext);
	}

	function handleItemClick(item: FileTreeNode): void {
		if (item.type === 'directory') {
			store.toggleDirectory(item.path);
			return;
		}
		if (isImageFile(item.name)) {
			onImageSelect?.(item);
			return;
		}
		onFileSelect(item);
	}

	function formatFileSize(bytes: number | undefined): string {
		if (!bytes || bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}

	function formatRelativeTime(date: string | undefined): string {
		if (!date) return '-';
		const now = new Date();
		const past = new Date(date);
		const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);
		if (diffInSeconds < 60) return m.filetree_just_now();
		if (diffInSeconds < 3600) return m.filetree_min_ago({ count: Math.floor(diffInSeconds / 60) });
		if (diffInSeconds < 86400) return m.filetree_hours_ago({ count: Math.floor(diffInSeconds / 3600) });
		if (diffInSeconds < 2592000) return m.filetree_days_ago({ count: Math.floor(diffInSeconds / 86400) });
		return past.toLocaleDateString();
	}

	function getFileIconType(filename: string): 'code' | 'doc' | 'image' | 'generic' {
		const ext = filename.split('.').pop()?.toLowerCase() ?? '';
		if (['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'cpp', 'c', 'php', 'rb', 'go', 'rs'].includes(ext)) return 'code';
		if (['md', 'txt', 'doc', 'pdf'].includes(ext)) return 'doc';
		if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return 'image';
		return 'generic';
	}

	function rowClass(path: string): string {
		return selectedPath === path
			? 'bg-accent text-foreground ring-1 ring-ring/30'
			: 'text-foreground';
	}

	function headerButtonClass(active: boolean): string {
		return active
			? 'inline-flex items-center gap-1 text-foreground hover:text-foreground'
			: 'inline-flex items-center gap-1 hover:text-foreground';
	}
</script>

{#snippet sortIcon(column: SortKey)}
	{#if store.sortKey === column}
		{#if store.sortDirection === 'asc'}
			<ChevronUp class="w-3 h-3" />
		{:else}
			<ChevronDown class="w-3 h-3" />
		{/if}
	{:else}
		<ArrowUpDown class="w-3 h-3 opacity-50" />
	{/if}
{/snippet}

{#snippet fileIcon(filename: string)}
	{@const iconType = getFileIconType(filename)}
	{#if iconType === 'code'}
		<FileCode class="w-4 h-4 text-file-icon-code flex-shrink-0" />
	{:else if iconType === 'doc'}
		<FileText class="w-4 h-4 text-file-icon-doc flex-shrink-0" />
	{:else if iconType === 'image'}
		<File class="w-4 h-4 text-file-icon-image flex-shrink-0" />
	{:else}
		<File class="w-4 h-4 text-muted-foreground flex-shrink-0" />
	{/if}
{/snippet}

{#snippet detailedTreeItem(item: FileTreeNode, level: number)}
	{@const isExpanded = store.expandedDirs.has(item.path)}
	{@const children = store.getChildren(item)}
	{@const isLoadingDir = store.loadingDirs.has(item.path)}
	<div class="select-none">
		<button
			type="button"
			class={`grid grid-cols-12 gap-2 px-2 py-1.5 hover:bg-accent cursor-pointer items-center w-full text-left rounded-sm ${rowClass(item.path)}`}
			style={`padding-left: ${level * 16 + 12}px`}
			onclick={() => handleItemClick(item)}
			role="treeitem"
			aria-level={level + 1}
			aria-expanded={item.type === 'directory' ? isExpanded : undefined}
			aria-selected={selectedPath === item.path}
			tabindex={0}
		>
			<div class="col-span-5 flex items-center gap-2 min-w-0">
				{#if item.type === 'directory'}
					{#if isExpanded}
						<FolderOpen class="w-4 h-4 text-file-icon-folder flex-shrink-0" />
					{:else}
						<Folder class="w-4 h-4 text-muted-foreground flex-shrink-0" />
					{/if}
				{:else}
					{@render fileIcon(item.name)}
				{/if}
				<span class="text-sm truncate">{item.name}</span>
				{#if isLoadingDir}
					<span class="text-xs text-muted-foreground animate-pulse">...</span>
				{/if}
			</div>
			<div class="col-span-2 text-sm text-muted-foreground">
				{item.type === 'file' ? formatFileSize(item.size) : '-'}
			</div>
			<div class="col-span-3 text-sm text-muted-foreground">
				{formatRelativeTime(item.modified)}
			</div>
			<div class="col-span-2 text-sm text-muted-foreground font-mono">
				{item.permissionsRwx || '-'}
			</div>
		</button>

		{#if item.type === 'directory' && isExpanded && children}
			{#each children as child (child.path)}
				{@render detailedTreeItem(child, level + 1)}
			{/each}
		{/if}
	</div>
{/snippet}

{#if store.isLoading}
	<div class="h-full flex items-center justify-center">
		<div class="text-muted-foreground">{m.filetree_loading()}</div>
	</div>
{:else}
	<div class="h-full min-h-0 flex flex-col bg-card">
		<div class="p-2 border-b border-border">
			<div class="flex items-center gap-1">
				<div class="relative min-w-0 flex-1">
					<Search class="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
					<Input
						type="text"
						placeholder={m.filetree_search_placeholder()}
						bind:value={store.searchInput}
						class="pl-8 pr-8 h-8 text-sm"
					/>
					{#if store.searchInput}
						<Button
							variant="ghost"
							size="icon-sm"
							class="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 hover:bg-accent"
							onclick={() => (store.searchInput = '')}
							title={m.filetree_clear_search()}
						>
							<X class="w-3 h-3" />
						</Button>
					{/if}
				</div>
				<Button variant="ghost" size="icon-sm" onclick={() => store.refresh()} title="Refresh files">
					<RefreshCw class="w-4 h-4" />
				</Button>
				<FileTreeSettingsMenu
					showHiddenFiles={store.showHiddenFiles}
					foldersFirst={store.foldersFirst}
					onShowHiddenFilesChange={(v) => store.setShowHiddenFiles(v)}
					onFoldersFirstChange={(v) => store.setFoldersFirst(v)}
				/>
			</div>
		</div>

		{#if displayFiles.length > 0}
			<div class="px-2 pt-1 pb-1 border-b border-border bg-card">
				<div class="grid grid-cols-12 gap-2 px-2 text-xs font-medium text-muted-foreground">
					<div class="col-span-5">
						<button type="button" class={headerButtonClass(store.sortKey === 'name')} onclick={() => store.toggleSort('name')} aria-label="Sort by name">
							{m.filetree_name()}
							{@render sortIcon('name')}
						</button>
					</div>
					<div class="col-span-2">
						<button type="button" class={headerButtonClass(store.sortKey === 'size')} onclick={() => store.toggleSort('size')} aria-label="Sort by size">
							{m.filetree_size()}
							{@render sortIcon('size')}
						</button>
					</div>
					<div class="col-span-3">
						<button type="button" class={headerButtonClass(store.sortKey === 'modified')} onclick={() => store.toggleSort('modified')} aria-label="Sort by modified time">
							{m.filetree_modified()}
							{@render sortIcon('modified')}
						</button>
					</div>
					<div class="col-span-2">
						<button type="button" class={headerButtonClass(store.sortKey === 'permissions')} onclick={() => store.toggleSort('permissions')} aria-label="Sort by permissions">
							{m.filetree_permissions()}
							{@render sortIcon('permissions')}
						</button>
					</div>
				</div>
			</div>
		{/if}

		<ScrollArea class="min-h-0 flex-1 px-2 py-1 overscroll-contain">
			{#if store.rootFiles.length === 0}
				<div class="text-center py-8">
					<div class="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-3">
						<Folder class="w-6 h-6 text-muted-foreground" />
					</div>
					<h4 class="font-medium text-foreground mb-1">{m.filetree_no_files_found()}</h4>
					<p class="text-sm text-muted-foreground">{m.filetree_check_project_path()}</p>
				</div>
			{:else if displayFiles.length === 0 && store.debouncedQuery}
				<div class="text-center py-8">
					<div class="w-12 h-12 bg-muted rounded-lg flex items-center justify-center mx-auto mb-3">
						<Search class="w-6 h-6 text-muted-foreground" />
					</div>
					<h4 class="font-medium text-foreground mb-1">{m.filetree_no_matches_found()}</h4>
					<p class="text-sm text-muted-foreground">{m.filetree_try_different_search()}</p>
					<div class="mt-3">
						<Button variant="outline" size="sm" onclick={() => (store.searchInput = '')}>Clear search</Button>
					</div>
				</div>
			{:else}
				<div role="tree" aria-label="Project files">
					{#each displayFiles as item (item.path)}
						{@render detailedTreeItem(item, 0)}
					{/each}
				</div>
			{/if}
		</ScrollArea>
	</div>
{/if}
