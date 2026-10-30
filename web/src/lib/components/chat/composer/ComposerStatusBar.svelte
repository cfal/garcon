<script lang="ts">
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import GitSummaryButton from '$lib/components/git/GitSummaryButton.svelte';
	import GitBranchSelector from '$lib/components/git/GitBranchSelector.svelte';
	import type { GitQuickSummaryReady } from '$lib/api/git.js';
	import type { ComposerStatusBarBranchControls } from './composer-status-bar-types.js';
	import * as m from '$lib/paraglide/messages.js';
	import ComposerStatusBarFrame from './ComposerStatusBarFrame.svelte';
	import type { ComposerStatusBarPresentation } from '$lib/chat/composer/composer-status-bar.js';
	import { cn } from '$lib/utils/cn';
	import { splitProjectPath } from '$lib/project-paths/compact-project-path';

	interface Props {
		items: ComposerStatusBarPresentation;
		projectPath: string;
		onProjectPath?: () => void;
		summary: GitQuickSummaryReady | null;
		isRefreshing: boolean;
		isMobile?: boolean;
		lastError?: string | null;
		branchSelector?: ComposerStatusBarBranchControls | null;
		onCommit: () => void;
		announcementsEnabled?: boolean;
	}

	let {
		items,
		projectPath,
		onProjectPath,
		summary,
		isRefreshing,
		isMobile = false,
		lastError = null,
		branchSelector = null,
		onCommit,
		announcementsEnabled = true,
	}: Props = $props();
	const pathParts = $derived(splitProjectPath(projectPath));
	const pathSeparator = $derived(
		pathParts.parent && !/[\\/]$/.test(pathParts.parent)
			? projectPath[pathParts.parent.length]
			: '',
	);
	const projectPathLabel = $derived(`${m.sidebar_project_path_menu_item()}: ${projectPath}`);
	const targetButtonClass =
		'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

	const gitBusy = $derived((items.gitBranch || items.commit) && isRefreshing);
</script>

{#if items.visible}
	<ComposerStatusBarFrame {announcementsEnabled} busy={gitBusy}>
		{#if items.projectPath || items.gitBranch}
			<div
				class="@container/composer-targets grid min-w-0 flex-1 grid-flow-col auto-cols-[minmax(0,max-content)] items-center justify-start gap-2 text-xs"
			>
				{#if items.projectPath}
					<button
						type="button"
						class={cn(
							targetButtonClass,
							'w-8 min-w-0 justify-center disabled:cursor-not-allowed disabled:opacity-50',
							items.gitBranch
								? '@[18rem]/composer-targets:w-auto'
								: '@[10rem]/composer-targets:w-auto',
						)}
						onclick={onProjectPath}
						disabled={!onProjectPath}
						aria-label={projectPathLabel}
						aria-haspopup="dialog"
						title={projectPathLabel}
						data-composer-project-path
					>
						<FolderOpen class="h-3.5 w-3.5 shrink-0" />
						<span
							class={cn(
								'hidden min-w-0 font-medium text-foreground',
								items.gitBranch
									? '@[18rem]/composer-targets:flex'
									: '@[10rem]/composer-targets:flex',
							)}
							aria-hidden="true"
							data-composer-project-path-label
						>
							<span class="min-w-0 shrink-[9999] overflow-hidden text-ellipsis whitespace-pre"
								>{pathParts.parent}</span
							>
							<span class="min-w-0 overflow-hidden text-ellipsis whitespace-pre"
								>{pathSeparator}{pathParts.name}</span
							>
						</span>
						<ChevronDown
							class={cn(
								'hidden h-3.5 w-3.5 shrink-0',
								items.gitBranch
									? '@[18rem]/composer-targets:block'
									: '@[10rem]/composer-targets:block',
							)}
						/>
					</button>
				{/if}
				{#if items.gitBranch && summary}
					{#if branchSelector}
						<GitBranchSelector
							currentBranch={summary.branch || 'HEAD'}
							refs={branchSelector.refs}
							sort={branchSelector.sort}
							isOpen={branchSelector.isOpen}
							isLoading={branchSelector.isLoading}
							{isMobile}
							side="top"
							menuClass="w-[min(36rem,calc(100vw-2rem))]"
							triggerClass={cn(targetButtonClass, 'min-w-0 max-w-44 sm:max-w-80')}
							iconClass="h-3.5 w-3.5 shrink-0"
							labelClass="max-w-32 text-xs font-medium text-foreground"
							chevronClass="h-3.5 w-3.5 shrink-0"
							onToggle={branchSelector.onToggle}
							onClose={branchSelector.onClose}
							onCreateBranch={branchSelector.onCreateBranch}
							onSwitchBranch={branchSelector.onSwitchBranch}
							onSearchRefs={branchSelector.onSearchRefs}
							onSortRefs={branchSelector.onSortRefs}
							onSwitchDialogClose={branchSelector.onSwitchDialogClose}
						/>
					{:else}
						<span
							data-slot="chat-git-branch"
							class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background/65 px-2 py-1 text-muted-foreground"
							title={summary.branch}
						>
							<GitBranch class="h-3.5 w-3.5 shrink-0" />
							<span class="max-w-32 truncate font-medium text-foreground"
								>{summary.branch || 'HEAD'}</span
							>
						</span>
					{/if}
				{/if}
			</div>
		{/if}
		{#if items.commit}
			<div class="ml-auto shrink-0">
				<GitSummaryButton {summary} {isRefreshing} {lastError} {onCommit} />
			</div>
		{/if}
	</ComposerStatusBarFrame>
{/if}
