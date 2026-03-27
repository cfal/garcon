<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { FolderEntry } from './sidebar-filter-state.svelte';

	interface SidebarFoldersProps {
		folders: FolderEntry[];
		selectedFolderId: string;
		onSelectFolder: (id: string) => void;
		onCreateFolder?: () => void;
		onDeleteFolder?: (id: string) => void;
	}

	let {
		folders,
		selectedFolderId,
		onSelectFolder,
		onCreateFolder,
		onDeleteFolder,
	}: SidebarFoldersProps = $props();
</script>

<div class="border-b border-border/40 pb-1">
	<div class="px-3 pt-2 pb-1 flex items-center justify-between">
		<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{m.sidebar_folders_title()}</span>
		{#if onCreateFolder}
			<button
				type="button"
				class="p-0.5 text-muted-foreground hover:text-foreground transition-colors rounded"
				onclick={onCreateFolder}
				aria-label={m.sidebar_folders_save_current_filter()}
				title={m.sidebar_folders_save_current_filter()}
			>
				<Plus class="w-3 h-3" />
			</button>
		{/if}
	</div>
	<div class="flex flex-col">
		{#each folders as folder (folder.id)}
			<button
				type="button"
				class={cn(
					'group flex items-center gap-1.5 px-3 py-1 text-xs transition-colors w-full text-left',
					selectedFolderId === folder.id
						? 'bg-accent text-accent-foreground font-medium'
						: 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
				)}
				onclick={() => onSelectFolder(folder.id)}
			>
				<FolderOpen class="w-3 h-3 shrink-0" />
				<span class="truncate flex-1">{folder.name}</span>
				{#if !folder.isSystem && onDeleteFolder}
					<!-- svelte-ignore node_invalid_placement_ssr — nested interactive element; SPA-only so no SSR hydration concern -->
					<span
						role="button"
						tabindex="-1"
						class="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-destructive transition-all rounded"
						onclick={(e) => { e.stopPropagation(); onDeleteFolder?.(folder.id); }}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDeleteFolder?.(folder.id); } }}
						aria-label={m.sidebar_folders_delete()}
						title={m.sidebar_folders_delete()}
					>
						<Trash2 class="w-3 h-3" />
					</span>
				{/if}
			</button>
		{/each}
	</div>
</div>
