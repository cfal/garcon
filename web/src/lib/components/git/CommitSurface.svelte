<script lang="ts">
	import { onDestroy } from 'svelte';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import FileIcon from '@lucide/svelte/icons/file';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import GripHorizontal from '@lucide/svelte/icons/grip-horizontal';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitCommitHorizontal from '@lucide/svelte/icons/git-commit-horizontal';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import type { GitTreeNode } from '$lib/api/git.js';
	import type { CommitController } from '$lib/stores/commit.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import GitBranchSelector from './GitBranchSelector.svelte';
	import { getGitBranchActions } from '$lib/context';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';

	interface Props {
		controller: CommitController;
		presentation: 'main' | 'sidebar' | 'mobile';
	}

	let { controller, presentation }: Props = $props();
	const gitBranchActions = getGitBranchActions();
	const isMobile = $derived(presentation === 'mobile');
	let dialogBodyEl = $state<HTMLDivElement | null>(null);
	let messagePanePercent = $state(28);
	let resizeCleanup: (() => void) | null = null;

	const dialogBodyGridStyle = $derived(
		isMobile
			? 'grid-template-rows: minmax(0, 1fr) auto;'
			: `grid-template-rows: minmax(260px, ${100 - messagePanePercent}fr) auto minmax(150px, ${messagePanePercent}fr);`,
	);
	const messagePaneStyle = $derived(
		isMobile
			? 'padding: 0.75rem; padding-left: max(0.75rem, env(safe-area-inset-left)); padding-right: max(0.75rem, env(safe-area-inset-right)); padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));'
			: undefined,
	);
	const actionBarClass = $derived(
		cn(isMobile ? 'grid grid-cols-1 gap-2' : 'flex flex-wrap items-center gap-2'),
	);
	const commitButtonClass = $derived(
		cn(
			'inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			isMobile ? 'w-full' : 'flex-1 min-w-[150px]',
			controller.canCommit
				? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
				: 'bg-muted text-muted-foreground cursor-not-allowed',
		),
	);
	const generateButtonClass = $derived(
		cn(
			'inline-flex h-9 min-w-0 items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			isMobile ? 'w-full' : '',
		),
	);
	const toolbarActions = $derived<ResponsiveSurfaceAction[]>([
		{
			id: 'refresh',
			label: m.filetree_refresh_files(),
			icon: RefreshCw,
			iconClass:
				controller.isRefreshingTree || controller.isLoadingTree ? 'animate-spin' : undefined,
			onclick: () => void controller.refreshTree(),
			disabled: controller.isLoadingTree || controller.isRefreshingTree,
			priority: 0,
		},
	]);

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

	function cleanupResize(): void {
		resizeCleanup?.();
		resizeCleanup = null;
	}

	function toggleBranchSelector(): void {
		const projectPath = controller.projectPath;
		if (!projectPath) return;
		if (gitBranchActions.showBranchDropdown) {
			gitBranchActions.closeBranchDropdown();
			return;
		}
		void gitBranchActions.openBranchDropdown(projectPath);
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
		cleanupResize();
	});
</script>

<div class="flex h-full min-h-0 min-w-0 overflow-hidden bg-background">
	<div class="flex min-h-0 min-w-0 flex-1 flex-col">
		<div
			class="surface-toolbar flex min-w-0 items-center justify-between gap-2 border-b border-border px-4 py-2"
			style="container-name: surface-toolbar; container-type: inline-size;"
		>
			<div class="flex min-w-0 items-center gap-2">
				<GitCommitHorizontal class="h-4 w-4 shrink-0 text-muted-foreground" />
				<h2 class="min-w-0 truncate text-sm font-medium text-foreground">
					{controller.selectedFileCount === 0
						? m.git_quick_commit_select_files()
						: m.git_changes_commit_files({ count: controller.selectedFileCount })}
				</h2>
				<div class="flex shrink-0 gap-1.5 text-xs tabular-nums">
					{#if controller.totalAdditions > 0}
						<span class="text-git-added">+{controller.totalAdditions}</span>
					{/if}
					{#if controller.totalDeletions > 0}
						<span class="text-git-deleted">-{controller.totalDeletions}</span>
					{/if}
				</div>
			</div>
			<ResponsiveSurfaceActions
				actions={toolbarActions}
				menuLabel={m.workspace_surface_actions()}
				class="max-w-64"
			>
				{#snippet fixed()}
					<GitBranchSelector
						currentBranch={gitBranchActions.currentBranch || 'HEAD'}
						refs={gitBranchActions.refs}
						isOpen={gitBranchActions.showBranchDropdown}
						isLoading={gitBranchActions.isLoadingBranches}
						isMobile={presentation === 'mobile'}
						triggerClass="h-8 max-w-40 px-2 text-xs"
						labelClass="max-w-24 text-xs"
						onToggle={toggleBranchSelector}
						onClose={() => gitBranchActions.closeBranchDropdown()}
						onCreateBranch={() => {
							if (controller.projectPath && controller.effectiveProjectKey)
								gitBranchActions.openNewBranchDialog(
									controller.projectPath,
									'singleton:commit',
									controller.effectiveProjectKey,
								);
						}}
						onSwitchBranch={(branch, refKind) => {
							if (controller.projectPath && controller.effectiveProjectKey) {
								void gitBranchActions.switchBranch(
									controller.projectPath,
									branch,
									refKind,
									'singleton:commit',
									controller.effectiveProjectKey,
								);
							}
						}}
						onSearchRefs={(query) => {
							if (controller.projectPath)
								return gitBranchActions.fetchRefs(controller.projectPath, query);
						}}
					/>
				{/snippet}
			</ResponsiveSurfaceActions>
		</div>

		<div bind:this={dialogBodyEl} class="grid min-h-0 min-w-0 flex-1" style={dialogBodyGridStyle}>
			<section class="min-h-0 min-w-0 overflow-hidden">
				<div class="relative flex h-full min-w-0 flex-col overflow-hidden">
					<div
						class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden py-1 {controller.treeErrorMessage
							? 'pb-12'
							: ''}"
					>
						{#if controller.isLoadingTree}
							<div
								class="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground"
							>
								<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
								<span>{m.filetree_loading()}</span>
							</div>
						{:else if controller.tree.length === 0}
							<div class="px-3 py-8 text-center text-xs text-muted-foreground">
								{m.git_quick_commit_no_changed_files()}
							</div>
						{:else}
							{#each controller.tree as node (node.path)}
								{@render treeNode(node, 0)}
							{/each}
						{/if}
					</div>
					{#if controller.treeErrorMessage}
						<div
							class="absolute inset-x-0 bottom-0 border-t border-status-error-border bg-status-error px-3 py-2 text-xs text-status-error-foreground shadow-sm"
						>
							<div class="flex min-w-0 items-center gap-2">
								<AlertTriangle class="h-3.5 w-3.5 shrink-0" />
								<span class="min-w-0 flex-1 truncate" title={controller.treeErrorMessage}>
									{controller.treeErrorMessage}
								</span>
							</div>
						</div>
					{/if}
				</div>
			</section>

			{#if !isMobile}
				<button
					type="button"
					class="group flex h-3 items-center justify-center border-y border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onpointerdown={handlePaneResizeStart}
					aria-label={m.git_quick_commit_resize_files_message()}
				>
					<GripHorizontal class="h-3.5 w-3.5" />
				</button>
			{/if}

			<section
				class="flex min-h-0 min-w-0 flex-col border-t border-border {isMobile
					? 'gap-2'
					: 'gap-3 p-4'}"
				style={messagePaneStyle}
			>
				<textarea
					value={controller.message}
					oninput={(event) => {
						controller.message = event.currentTarget.value;
					}}
					placeholder={m.git_commit_message_placeholder()}
					rows={isMobile ? 3 : 5}
					class="resize-none rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {isMobile
						? 'h-20 min-h-20'
						: 'min-h-20 flex-1'}"></textarea>

				<div class={actionBarClass}>
					<button
						type="button"
						onclick={() => void controller.commit()}
						disabled={!controller.canCommit}
						class={commitButtonClass}
					>
						{#if controller.isCommitting || controller.preparingAction === 'commit'}
							<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						{/if}
						{controller.preparingAction === 'commit'
							? m.git_quick_commit_preparing_index()
							: m.git_changes_commit()}
					</button>
					<button
						type="button"
						onclick={() => void controller.generateMessage()}
						disabled={controller.desiredSelectedFiles.length === 0 ||
							controller.isGeneratingMessage}
						class={generateButtonClass}
						title={m.git_changes_generate_message()}
					>
						{#if controller.isGeneratingMessage || controller.preparingAction === 'generate'}
							<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<Sparkles class="h-3.5 w-3.5" />
						{/if}
						<span class="min-w-0 truncate">
							{controller.preparingAction === 'generate'
								? m.git_quick_commit_preparing_index()
								: m.git_quick_commit_generate()}
						</span>
					</button>
				</div>
			</section>
		</div>
	</div>
</div>

{#snippet treeNode(node: GitTreeNode, depth: number)}
	{#if node.kind === 'directory'}
		{@const selection = controller.directorySelection(node.path)}
		<div
			class="group flex min-w-0 max-w-full items-center gap-2 overflow-hidden px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
			style="padding-left: {depth * 14 + 10}px"
		>
			<input
				type="checkbox"
				checked={selection.checked}
				use:indeterminate={selection.mixed}
				onchange={() =>
					controller.toggleDirectory(node.path, selection.mixed ? true : !selection.checked)}
				disabled={selection.fileCount === 0}
				class="size-3.5 shrink-0 accent-current"
				aria-checked={selection.mixed ? 'mixed' : selection.checked}
				aria-label={selection.checked && !selection.mixed
					? m.git_quick_commit_unstage_path({ path: node.path })
					: m.git_quick_commit_stage_path({ path: node.path })}
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
		</div>
		{#if node.children}
			{#each node.children as child (child.path)}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{:else}
		{@const intent = controller.intentFor(node.path)}
		{@const stats = controller.nodeStats(node.path)}
		<div
			class="group flex min-w-0 max-w-full items-center gap-2 overflow-hidden px-2 py-1.5 text-xs hover:bg-muted/50"
			style="padding-left: {depth * 14 + 10}px"
		>
			<input
				type="checkbox"
				checked={intent?.desiredSelected ?? false}
				onchange={(event) => controller.togglePath(node.path, event.currentTarget.checked)}
				class="size-3.5 shrink-0 accent-current"
				aria-label={controller.operationLabelForPath(node.path)}
			/>
			{#if intent?.isRunning}
				<LoaderCircle
					class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
					aria-label={controller.operationLabelForPath(node.path)}
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
					onclick={() => controller.includeUnstaged(node.path)}
					class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:hidden"
					title={m.git_quick_commit_include_unstaged()}
					aria-label={m.git_quick_commit_include_unstaged()}
				>
					<Plus class="h-3 w-3" />
				</button>
				<button
					type="button"
					onclick={() => controller.includeUnstaged(node.path)}
					class="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:inline-flex sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
				>
					{m.git_quick_commit_include_unstaged()}
				</button>
			{/if}
		</div>
	{/if}
{/snippet}
