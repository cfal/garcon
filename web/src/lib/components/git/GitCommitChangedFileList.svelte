<script lang="ts">
	import FileText from '@lucide/svelte/icons/file-text';
	import Search from '@lucide/svelte/icons/search';
	import type { GitCommitFileSummary } from '$lib/api/git.js';

	interface GitCommitChangedFileListProps {
		files: GitCommitFileSummary[];
		fileFilter: string;
		focusedFilePath: string | null;
		isMobile: boolean;
		onFileFilterChange: (value: string) => void;
		onSelectFile: (filePath: string) => void;
	}

	let {
		files,
		fileFilter,
		focusedFilePath,
		isMobile,
		onFileFilterChange,
		onSelectFile,
	}: GitCommitChangedFileListProps = $props();

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

<aside
	class="{isMobile
		? 'flex min-h-0 flex-1 flex-col border-b border-border'
		: 'flex min-h-0 w-72 shrink-0 flex-col border-r border-border'} bg-background"
>
	<div class="border-b border-border p-2">
		<div class="relative">
			<Search
				class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				type="search"
				class="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				placeholder="Filter files"
				value={fileFilter}
				oninput={(event) => onFileFilterChange(event.currentTarget.value)}
			/>
		</div>
	</div>
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if files.length === 0}
			<div class="px-3 py-5 text-xs text-muted-foreground">No changed files match the filter.</div>
		{:else}
			{#each files as file (file.path)}
				<button
					type="button"
					class="flex w-full min-w-0 items-start gap-2 border-b border-border/60 px-2 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent {focusedFilePath ===
					file.path
						? 'bg-muted/60'
						: ''}"
					onclick={() => onSelectFile(file.path)}
				>
					<span
						class="mt-0.5 w-5 shrink-0 rounded bg-muted px-1 py-0.5 text-center text-[10px] text-muted-foreground"
					>
						{statusLabel(file.status)}
					</span>
					<FileText class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1">
						<span class="block truncate font-mono text-xs text-foreground" title={file.path}>
							{file.path}
						</span>
						{#if file.originalPath}
							<span
								class="block truncate text-[10px] text-muted-foreground"
								title={file.originalPath}
							>
								from {file.originalPath}
							</span>
						{/if}
					</span>
					<span class="shrink-0 text-[10px] text-git-added">+{file.additions}</span>
					<span class="shrink-0 text-[10px] text-git-deleted">-{file.deletions}</span>
				</button>
			{/each}
		{/if}
	</div>
</aside>
