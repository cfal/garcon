<script lang="ts">
	// Modal shown when the user clicks Commit in the toolbar.
	// Displays the list of staged files with +/- stats, a commit
	// message textarea with AI generation, and the final commit button.

	import X from '@lucide/svelte/icons/x';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FileMinus from '@lucide/svelte/icons/file-minus';
	import FileEdit from '@lucide/svelte/icons/file-pen-line';
	import FileQuestion from '@lucide/svelte/icons/file-question';
	import type { GitTreeNode } from '$lib/api/git.js';

	interface Props {
		stagedFiles: GitTreeNode[];
		commitMessage: string;
		isCommitting: boolean;
		isGeneratingMessage: boolean;
		canGenerate: boolean;
		isMobile: boolean;
		commonDirPrefix?: string;
		onMessageChange: (msg: string) => void;
		onCommit: () => void;
		onGenerate: () => void;
		onClose: () => void;
	}

	let {
		stagedFiles,
		commitMessage,
		isCommitting,
		isGeneratingMessage,
		canGenerate,
		isMobile,
		commonDirPrefix = '',
		onMessageChange,
		onCommit,
		onGenerate,
		onClose,
	}: Props = $props();

	let totalAdditions = $derived(stagedFiles.reduce((sum, f) => sum + (f.additions ?? 0), 0));
	let totalDeletions = $derived(stagedFiles.reduce((sum, f) => sum + (f.deletions ?? 0), 0));
	let canCommit = $derived(commitMessage.trim().length > 0 && stagedFiles.length > 0 && !isCommitting);

	function changeIcon(kind: GitTreeNode['changeKind']) {
		switch (kind) {
			case 'added':
			case 'untracked': return FilePlus;
			case 'deleted': return FileMinus;
			case 'modified': return FileEdit;
			default: return FileQuestion;
		}
	}

	function changeColor(kind: GitTreeNode['changeKind']): string {
		switch (kind) {
			case 'added':
			case 'untracked': return 'text-git-added';
			case 'deleted': return 'text-git-deleted';
			case 'modified': return 'text-git-modified';
			default: return 'text-muted-foreground';
		}
	}

	function handleTextareaFocus(): void {
		if (!commitMessage && commonDirPrefix) {
			onMessageChange(`${commonDirPrefix}: `);
		}
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) onClose();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
			e.preventDefault();
			onCommit();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
>
	<div class="bg-background border border-border rounded-lg shadow-xl flex flex-col
		{isMobile ? 'w-full h-full rounded-none' : 'w-[480px] max-h-[80vh]'}">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
			<div class="flex items-center gap-2">
				<h2 class="text-sm font-medium text-foreground">
					Commit {stagedFiles.length} file{stagedFiles.length === 1 ? '' : 's'}
				</h2>
				<div class="flex items-center gap-1.5 text-xs">
					{#if totalAdditions > 0}
						<span class="text-git-added">+{totalAdditions}</span>
					{/if}
					{#if totalDeletions > 0}
						<span class="text-git-deleted">-{totalDeletions}</span>
					{/if}
				</div>
			</div>
			<button
				onclick={onClose}
				class="p-1 rounded hover:bg-muted transition-colors text-muted-foreground"
			>
				<X class="w-4 h-4" />
			</button>
		</div>

		<!-- Staged files list -->
		<div class="flex-1 overflow-y-auto min-h-0 border-b border-border">
			{#each stagedFiles as file (file.path)}
				{@const Icon = changeIcon(file.changeKind)}
				<div class="flex items-center gap-2 px-4 py-1.5 text-xs hover:bg-muted/50">
					<Icon class="w-3.5 h-3.5 shrink-0 {changeColor(file.changeKind)}" />
					<span class="flex-1 truncate text-foreground" title={file.path}>{file.path}</span>
					<span class="shrink-0 tabular-nums text-muted-foreground">
						{#if (file.additions ?? 0) > 0}
							<span class="text-git-added">+{file.additions}</span>
						{/if}
						{#if (file.deletions ?? 0) > 0}
							{#if (file.additions ?? 0) > 0}&nbsp;{/if}
							<span class="text-git-deleted">-{file.deletions}</span>
						{/if}
					</span>
				</div>
			{/each}
		</div>

		<!-- Commit message -->
		<div class="px-4 py-3 space-y-2 shrink-0">
			<textarea
				value={commitMessage}
				oninput={(e) => onMessageChange(e.currentTarget.value)}
				onfocus={handleTextareaFocus}
				placeholder="Commit message..."
				class="w-full text-sm p-2.5 bg-muted/30 border border-border rounded-md resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
				rows="3"
			></textarea>
			<div class="flex items-center gap-2">
				<button
					onclick={onCommit}
					disabled={!canCommit}
					class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors
						{canCommit
							? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
							: 'bg-muted text-muted-foreground cursor-not-allowed'}"
				>
					{#if isCommitting}
						<LoaderCircle class="w-3.5 h-3.5 animate-spin" />
					{/if}
					Commit
				</button>
				{#if canGenerate}
					<button
						onclick={onGenerate}
						disabled={stagedFiles.length === 0 || isGeneratingMessage}
						class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
						title="Generate commit message"
					>
						{#if isGeneratingMessage}
							<LoaderCircle class="w-3.5 h-3.5 animate-spin" />
						{:else}
							<Sparkles class="w-3.5 h-3.5" />
						{/if}
						Generate
					</button>
				{/if}
			</div>
			<p class="text-[10px] text-muted-foreground">{isMobile ? 'Tap' : 'Press'} {isMobile ? 'Commit' : '\u2318/Ctrl+Enter'} to commit</p>
		</div>
	</div>
</div>
