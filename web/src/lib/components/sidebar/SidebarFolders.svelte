<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Plus from '@lucide/svelte/icons/plus';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Edit2 from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
	} from '$lib/components/ui/dropdown-menu';
	import type { FolderEntry } from './sidebar-filter-state.svelte';

	interface SidebarFoldersProps {
		folders: FolderEntry[];
		selectedFolderId: string;
		canCreateFolder?: boolean;
		createFolderHint?: string;
		folderCounts?: Map<string, number>;
		onSelectFolder: (id: string) => void;
		onCreateFolder?: () => void;
		onDeleteFolder?: (id: string) => void;
		onEditFolder?: (folder: FolderEntry) => void;
	}

	let {
		folders,
		selectedFolderId,
		canCreateFolder = true,
		createFolderHint = m.sidebar_folders_create_saved_view_hint(),
		folderCounts,
		onSelectFolder,
		onCreateFolder,
		onDeleteFolder,
		onEditFolder,
	}: SidebarFoldersProps = $props();

	let userFolderCount = $derived(folders.filter(f => !f.isSystem).length);
</script>

<div class="border-b border-border/40 pb-1">
	<div class="px-3 pt-2 pb-1 flex items-center justify-between">
		<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{m.sidebar_folders_title()}</span>
		{#if onCreateFolder}
			<button
				type="button"
				class="p-0.5 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 transition-colors rounded"
				onclick={onCreateFolder}
				disabled={!canCreateFolder}
				aria-label={m.sidebar_folders_create_saved_view_hint()}
				title={createFolderHint}
			>
				<Plus class="w-3 h-3" />
			</button>
		{/if}
	</div>
	<div class="flex flex-col">
		{#each folders as folder (folder.id)}
			<div
				class={cn(
					'group flex items-center text-xs transition-colors',
					selectedFolderId === folder.id
						? 'bg-accent text-accent-foreground font-medium'
						: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
				)}
			>
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1 text-left"
					onclick={() => onSelectFolder(folder.id)}
					aria-pressed={selectedFolderId === folder.id}
				>
					<FolderOpen class="w-3 h-3 shrink-0" />
					<span class="truncate flex-1">{folder.name}</span>
					{#if folderCounts?.has(folder.id)}
						<span class="text-[10px] text-muted-foreground tabular-nums ml-auto shrink-0">
							{folderCounts.get(folder.id)}
						</span>
					{/if}
				</button>
				{#if !folder.isSystem && (onDeleteFolder || onEditFolder)}
					<DropdownMenu>
						<DropdownMenuTrigger>
							<button
								type="button"
								class={cn(
									'mr-2 rounded p-0.5 opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
									selectedFolderId === folder.id
										? 'text-accent-foreground/70 hover:text-foreground'
										: 'text-muted-foreground hover:text-foreground',
								)}
								aria-label={m.sidebar_actions_more()}
							>
								<EllipsisVertical class="w-3 h-3" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{#if onEditFolder}
								<DropdownMenuItem onclick={() => onEditFolder?.(folder)}>
									<Edit2 class="w-3.5 h-3.5 mr-2" />
									{m.sidebar_folders_edit()}
								</DropdownMenuItem>
							{/if}
							{#if onDeleteFolder}
								<DropdownMenuItem class="text-destructive" onclick={() => onDeleteFolder?.(folder.id)}>
									<Trash2 class="w-3.5 h-3.5 mr-2" />
									{m.sidebar_folders_delete()}
								</DropdownMenuItem>
							{/if}
						</DropdownMenuContent>
					</DropdownMenu>
				{/if}
			</div>
		{/each}
		{#if userFolderCount === 0}
			<div class="px-3 py-2 text-xs text-muted-foreground italic">
				{m.sidebar_folders_empty_state()}
			</div>
		{/if}
	</div>
</div>
