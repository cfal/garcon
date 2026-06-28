<script lang="ts">
	import { onDestroy } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import GripHorizontal from '@lucide/svelte/icons/grip-horizontal';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import type { GitTreeNode } from '$lib/api/git.js';
	import type { QuickCommitDialogState } from '$lib/stores/git/quick-commit-dialog-state.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		dialog: QuickCommitDialogState;
		isMobile: boolean;
	}

	let { dialog, isMobile }: Props = $props();
	let dialogBodyEl = $state<HTMLDivElement | null>(null);
	let messagePanePercent = $state(28);
	let resizeCleanup: (() => void) | null = null;

	const dialogBodyGridStyle = $derived(
		isMobile
			? 'grid-template-rows: minmax(0, 1fr) auto;'
			: `grid-template-rows: minmax(260px, ${100 - messagePanePercent}fr) auto minmax(150px, ${messagePanePercent}fr);`,
	);

	function handleBackdropClick(event: MouseEvent): void {
		if (event.target === event.currentTarget) dialog.close();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			dialog.close();
			return;
		}
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dialog.canCommit) {
			event.preventDefault();
			void dialog.commit();
		}
	}

	function handleTextareaFocus(): void {
		if (!dialog.message && dialog.commonDirPrefix) {
			dialog.message = `${dialog.commonDirPrefix}: `;
		}
	}

	function fileBadge(node: GitTreeNode): string {
		if (node.staged && node.hasUnstaged) return 'mixed';
		if (node.changeKind === 'untracked') return 'untracked';
		if (node.staged) return 'staged';
		return 'unstaged';
	}

	function clampMessagePanePercent(value: number): number {
		return Math.max(18, Math.min(52, value));
	}

	function handlePaneResizeStart(event: PointerEvent): void {
		event.preventDefault();
		const bodyEl = dialogBodyEl;
		if (!bodyEl) return;
		const bounds = bodyEl.getBoundingClientRect();
		if (bounds.height <= 0) return;

		document.body.style.cursor = 'row-resize';
		document.body.style.userSelect = 'none';
		document.body.style.touchAction = 'none';

		function handlePointerMove(moveEvent: PointerEvent): void {
			const nextPercent = ((bounds.bottom - moveEvent.clientY) / bounds.height) * 100;
			messagePanePercent = clampMessagePanePercent(nextPercent);
		}

		function handlePointerUp(): void {
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			document.body.style.touchAction = '';
			resizeCleanup = null;
		}

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		resizeCleanup = handlePointerUp;
	}

	function indeterminate(
		node: HTMLInputElement,
		value: boolean,
	): { update(nextValue: boolean): void } {
		node.indeterminate = value;
		return {
			update(nextValue: boolean) {
				node.indeterminate = nextValue;
			},
		};
	}

	onDestroy(() => {
		resizeCleanup?.();
		resizeCleanup = null;
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if dialog.isOpen}
	<div
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		class="fixed inset-0 z-50 flex items-stretch justify-center overflow-hidden bg-black/50 md:items-center"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
	>
		<div
			class="flex min-h-0 overflow-hidden bg-background border border-border shadow-xl
				{isMobile
				? 'h-dvh max-h-dvh w-screen max-w-screen flex-col border-0'
				: 'h-[min(760px,86dvh)] w-[min(980px,92vw)] rounded-lg'}"
		>
			<div class="flex min-h-0 flex-1 flex-col">
				<div class="flex items-center justify-between border-b border-border px-4 py-3">
					<div class="flex min-w-0 items-center gap-2">
						<GitCommitHorizontal class="h-4 w-4 shrink-0 text-muted-foreground" />
						<h2 class="truncate text-sm font-medium text-foreground">
							Commit {dialog.selectedFileCount} file{dialog.selectedFileCount === 1 ? '' : 's'}
						</h2>
						<div class="flex shrink-0 gap-1.5 text-xs tabular-nums">
							{#if dialog.totalAdditions > 0}
								<span class="text-git-added">+{dialog.totalAdditions}</span>
							{/if}
							{#if dialog.totalDeletions > 0}
								<span class="text-git-deleted">-{dialog.totalDeletions}</span>
							{/if}
						</div>
					</div>
					<button
						type="button"
						onclick={() => dialog.close()}
						disabled={dialog.isCommitting}
						class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
						aria-label={m.editor_actions_close()}
					>
						<X class="h-4 w-4" />
					</button>
				</div>

				{#if dialog.lastError}
					<div
						class="flex items-center gap-2 border-b border-status-error-border bg-status-error/10 px-4 py-2 text-xs text-status-error-foreground"
					>
						<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
						<span class="min-w-0 flex-1 truncate">{dialog.lastError}</span>
					</div>
				{/if}

				<div
					bind:this={dialogBodyEl}
					class="grid min-h-0 flex-1"
					style={dialogBodyGridStyle}
				>
					<section class="min-h-0">
						<div class="flex h-full flex-col">
							<div class="min-h-0 flex-1 overflow-y-auto py-1">
								{#if dialog.isLoadingTree}
									<div class="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
										<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
										<span>Loading files</span>
									</div>
								{:else if dialog.tree.length === 0}
									<div class="px-3 py-8 text-center text-xs text-muted-foreground">No changed files</div>
								{:else}
									{#each dialog.tree as node (node.path)}
										{@render treeNode(node, 0)}
									{/each}
								{/if}
							</div>
						</div>
					</section>

					{#if !isMobile}
						<button
							type="button"
							class="group flex h-3 items-center justify-center border-y border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onpointerdown={handlePaneResizeStart}
							aria-label="Resize files and commit message"
						>
							<GripHorizontal class="h-3.5 w-3.5" />
						</button>
					{/if}

					<section class="flex min-h-0 flex-col border-t border-border {isMobile ? 'gap-2 p-3' : 'gap-3 p-4'}">
						<textarea
							value={dialog.message}
							oninput={(event) => {
								dialog.message = event.currentTarget.value;
							}}
							onfocus={handleTextareaFocus}
							placeholder={m.git_commit_message_placeholder()}
							rows={isMobile ? 3 : 5}
							class="resize-none rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {isMobile
								? 'h-20 min-h-20'
								: 'min-h-20 flex-1'}"
						></textarea>

						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								onclick={() => void dialog.commit()}
								disabled={!dialog.canCommit}
								class="inline-flex h-9 flex-1 min-w-[150px] items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors
									{dialog.canCommit
									? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
									: 'bg-muted text-muted-foreground cursor-not-allowed'}"
							>
								{#if dialog.isCommitting || dialog.preparingAction === 'commit'}
									<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
								{/if}
								{dialog.preparingAction === 'commit' ? 'Preparing index' : 'Commit'}
							</button>
							{#if dialog.commitGenerationEnabled}
								<button
									type="button"
									onclick={() => void dialog.generateMessage()}
									disabled={dialog.desiredSelectedFiles.length === 0 || dialog.isGeneratingMessage}
									class="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
									title={m.git_changes_generate_message()}
								>
									{#if dialog.isGeneratingMessage || dialog.preparingAction === 'generate'}
										<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Sparkles class="h-3.5 w-3.5" />
									{/if}
									{dialog.preparingAction === 'generate' ? 'Preparing index' : 'Generate'}
								</button>
							{/if}
							<button
								type="button"
								onclick={() => void dialog.refreshTree()}
								disabled={dialog.isLoadingTree || dialog.isRefreshingTree}
								class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
								title="Refresh files"
								aria-label="Refresh files"
							>
								<RefreshCw
									class="h-3.5 w-3.5 {dialog.isRefreshingTree || dialog.isLoadingTree
										? 'animate-spin'
										: ''}"
								/>
							</button>
						</div>

						{#if dialog.pendingStageOperationLabel}
							<div class="text-xs text-muted-foreground">{dialog.pendingStageOperationLabel}</div>
						{/if}
					</section>
				</div>
			</div>
		</div>
	</div>
{/if}

{#snippet treeNode(node: GitTreeNode, depth: number)}
	{#if node.kind === 'directory'}
		{@const selection = dialog.directorySelection(node.path)}
		<div
			class="group flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
			style="padding-left: {depth * 14 + 10}px"
		>
			<input
				type="checkbox"
				checked={selection.checked}
				use:indeterminate={selection.mixed}
				onchange={() => dialog.toggleDirectory(node.path, selection.mixed ? true : !selection.checked)}
				disabled={selection.fileCount === 0}
				class="size-3.5 shrink-0 accent-current"
				aria-checked={selection.mixed ? 'mixed' : selection.checked}
				aria-label="{selection.checked && !selection.mixed ? 'Unstage' : 'Stage'} {node.path}"
			/>
			{#if selection.isRunning}
				<LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
			{:else}
				<FolderIcon class="h-3.5 w-3.5 shrink-0" />
			{/if}
			<span class="min-w-0 flex-1 truncate" title={node.path}>{node.name}</span>
			{#if node.additions || node.deletions}
				<span class="flex shrink-0 gap-1 tabular-nums">
					{#if node.additions}
						<span class="text-git-added">+{node.additions}</span>
					{/if}
					{#if node.deletions}
						<span class="text-git-deleted">-{node.deletions}</span>
					{/if}
				</span>
			{/if}
			{#if selection.error}
				<span class="min-w-0 max-w-36 truncate text-[10px] text-status-error-foreground" title={selection.error}>
					{selection.error}
				</span>
			{/if}
		</div>
		{#if node.children}
			{#each node.children as child (child.path)}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{:else}
		{@const intent = dialog.intentFor(node.path)}
		{@const stats = dialog.nodeStats(node.path)}
		<div
			class="group flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50"
			style="padding-left: {depth * 14 + 10}px"
		>
			<input
				type="checkbox"
				checked={intent?.desiredSelected ?? false}
				onchange={(event) => dialog.togglePath(node.path, event.currentTarget.checked)}
				class="size-3.5 shrink-0 accent-current"
				aria-label={dialog.operationLabelForPath(node.path)}
			/>
			{#if intent?.isRunning}
				<LoaderCircle
					class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
					aria-label={dialog.operationLabelForPath(node.path)}
				/>
			{:else}
				<FileIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			{/if}
			<span class="min-w-0 flex-1 truncate text-foreground" title={node.path}>{node.name}</span>
			{#if stats.additions > 0 || stats.deletions > 0}
				<span class="flex shrink-0 gap-1 tabular-nums">
					{#if stats.additions > 0}
						<span class="text-git-added">+{stats.additions}</span>
					{/if}
					{#if stats.deletions > 0}
						<span class="text-git-deleted">-{stats.deletions}</span>
					{/if}
				</span>
			{/if}
			<span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
				{fileBadge(node)}
			</span>
			{#if node.staged && node.hasUnstaged}
				<button
					type="button"
					onclick={() => dialog.includeUnstaged(node.path)}
					class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					Include unstaged
				</button>
			{/if}
			{#if intent?.error}
				<span class="min-w-0 max-w-36 truncate text-[10px] text-status-error-foreground" title={intent.error}>
					{intent.error}
				</span>
			{/if}
		</div>
	{/if}
{/snippet}
