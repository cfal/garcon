<script lang="ts">
	// Unified top toolbar for the Git panel. Renders mode-specific
	// action sets for Changes and History views. Owns branch selector,
	// mode toggle, and all primary git actions.

	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Plus from '@lucide/svelte/icons/plus';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import History from '@lucide/svelte/icons/history';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Upload from '@lucide/svelte/icons/upload';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitDiffSettingsMenu from './GitDiffSettingsMenu.svelte';
	import type { GitRemoteStatus } from '$lib/api/git';
	import type { DiffMode } from '$lib/stores/git-workbench.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	interface GitTopToolbarProps {
		isMobile: boolean;
		activeView: 'changes' | 'history';
		currentBranch: string;
		branches: string[];
		remoteStatus: GitRemoteStatus | null;
		showBranchDropdown: boolean;
		isLoading: boolean;
		isPushing: boolean;
		reviewCount: number;
		canCommit: boolean;
		isCommitting: boolean;
		canPush: boolean;
		diffMode: DiffMode;
		contextLines: number;
		diffFontSize: string;
		onToggleBranchDropdown: () => void;
		onCloseBranchDropdown: () => void;
		onShowNewBranchModal: () => void;
		onSwitchBranch: (branch: string) => void;
		onViewCommits: () => void;
		onViewChanges: () => void;
		onOpenReview: () => void;
		onCommit: () => void;
		onPush: () => void;
		onSetDiffMode: (mode: DiffMode) => void;
		onSetContextLines: (lines: number) => void;
		onSetDiffFontSize: (size: string) => void;
		onOpenCommitSettings: () => void;
		onRevert: () => void;
		onRefresh: () => void;
	}

	let {
		isMobile,
		activeView,
		currentBranch,
		branches,
		remoteStatus,
		showBranchDropdown,
		isLoading,
		isPushing,
		reviewCount,
		canCommit,
		isCommitting,
		canPush,
		diffMode,
		contextLines,
		diffFontSize,
		onToggleBranchDropdown,
		onCloseBranchDropdown,
		onShowNewBranchModal,
		onSwitchBranch,
		onViewCommits,
		onViewChanges,
		onOpenReview,
		onCommit,
		onPush,
		onSetDiffMode,
		onSetContextLines,
		onSetDiffFontSize,
		onOpenCommitSettings,
		onRevert,
		onRefresh,
	}: GitTopToolbarProps = $props();

	let dropdownEl: HTMLDivElement;

	function handleClickOutside(event: MouseEvent) {
		if (dropdownEl && !dropdownEl.contains(event.target as Node)) {
			onCloseBranchDropdown();
		}
	}

	$effect(() => {
		if (showBranchDropdown) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	});
</script>

<div class="flex items-center justify-between border-b border-border {isMobile ? 'px-2 py-1' : 'px-3 py-1'}">
	<!-- Left: branch selector + mode badge -->
	<div class="flex items-center gap-2">
		<!-- Branch selector -->
		<div class="relative" bind:this={dropdownEl}>
			<button
				onclick={onToggleBranchDropdown}
				class="flex items-center hover:bg-accent rounded-lg transition-all duration-200 {isMobile ? 'gap-1.5 px-2 py-1' : 'gap-1.5 px-3 py-1.5'}"
			>
				<GitBranch class="text-muted-foreground w-4 h-4" />
				<span class="text-sm font-medium max-w-[140px] truncate">{currentBranch}</span>
				{#if remoteStatus?.hasRemote}
					<div class="flex items-center gap-0.5 text-xs">
						{#if remoteStatus.ahead > 0}
							<span class="text-status-success-foreground">{'\u2191'}{remoteStatus.ahead}</span>
						{/if}
						{#if remoteStatus.behind > 0}
							<span class="text-interactive-accent">{'\u2193'}{remoteStatus.behind}</span>
						{/if}
						{#if remoteStatus.isUpToDate}
							<span class="text-muted-foreground">{'\u2713'}</span>
						{/if}
					</div>
				{/if}
				<ChevronDown class="w-3.5 h-3.5 text-muted-foreground transition-transform {showBranchDropdown ? 'rotate-180' : ''}" />
			</button>

			{#if showBranchDropdown}
				<div class="absolute top-full left-0 mt-1 w-64 bg-popover rounded-lg shadow-lg border border-border z-50">
					<div class="py-1 max-h-64 overflow-y-auto">
						{#each branches as branch (branch)}
							<button
								onclick={() => onSwitchBranch(branch)}
								class="w-full text-left px-4 py-2 text-sm hover:bg-accent {branch === currentBranch ? 'bg-accent/50 font-medium' : 'text-muted-foreground'}"
							>
								<div class="flex items-center space-x-2">
									{#if branch === currentBranch}
										<Check class="w-3.5 h-3.5 text-status-success-foreground" />
									{/if}
									<span>{branch}</span>
								</div>
							</button>
						{/each}
					</div>
					<div class="border-t border-border py-1">
						<button
							onclick={() => { onShowNewBranchModal(); onCloseBranchDropdown(); }}
							class="w-full text-left px-4 py-2 text-sm hover:bg-accent flex items-center space-x-2"
						>
							<Plus class="w-3.5 h-3.5" />
							<span>{m.git_header_create_branch()}</span>
						</button>
					</div>
				</div>
			{/if}
		</div>

	</div>

	<!-- Right: mode-specific actions -->
	<div class="flex items-center {isMobile ? 'gap-1' : 'gap-1.5'}">
		{#if activeView === 'changes'}
			<!-- View commits toggle -->
			<button
				onclick={onViewCommits}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
				title="View commit history"
			>
				<History class="w-4 h-4" />
				{#if !isMobile}History{/if}
			</button>

			<!-- Review -->
			<button
				onclick={onOpenReview}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-all duration-200
					{reviewCount > 0
						? 'bg-interactive-accent/10 text-interactive-accent border-interactive-accent/30 hover:bg-interactive-accent/20'
						: 'border-border bg-background text-muted-foreground hover:text-foreground'}"
				title="Review changes"
			>
				<MessageSquare class="w-4 h-4" />
				{#if !isMobile}Review{/if}
				{#if reviewCount > 0}
					<span class="px-1.5 py-0 text-[10px] rounded-full bg-interactive-accent text-interactive-accent-foreground font-medium">
						{reviewCount}
					</span>
				{/if}
			</button>

			<!-- Commit -->
			<button
				onclick={onCommit}
				disabled={!canCommit || isCommitting}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200
					{canCommit && !isCommitting
						? 'bg-interactive-accent text-interactive-accent-foreground hover:brightness-110'
						: 'bg-muted text-muted-foreground cursor-not-allowed'}"
				title="Commit staged changes"
			>
				Commit
			</button>

			<!-- Push -->
			<button
				onclick={onPush}
				disabled={!canPush || isPushing}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-200
					{canPush && !isPushing
						? 'bg-git-action-push text-git-action-foreground hover:bg-git-action-push-hover'
						: 'bg-muted text-muted-foreground cursor-not-allowed'}"
				title="Push to remote"
				aria-label="Push"
			>
				<Upload class="w-4 h-4 {isPushing ? 'animate-pulse' : ''}" />
				{#if !isMobile}Push{/if}
			</button>

			<!-- Settings popup -->
			<GitDiffSettingsMenu
				{diffMode}
				{contextLines}
				{diffFontSize}
				onSetDiffMode={onSetDiffMode}
				onSetContextLines={onSetContextLines}
				onSetDiffFontSize={onSetDiffFontSize}
				{onOpenCommitSettings}
			/>

			<!-- Refresh -->
			<button
				onclick={onRefresh}
				disabled={isLoading}
				class="p-2 rounded-lg hover:bg-muted transition-all duration-200 text-muted-foreground"
				title={m.git_header_refresh()}
			>
				<RefreshCw class="w-4 h-4 {isLoading ? 'animate-spin' : ''}" />
			</button>

		{:else}
			<!-- History mode actions -->

			<!-- Back to changes -->
			<button
				onclick={onViewChanges}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-all duration-200"
				title="View changes"
			>
				<ArrowLeft class="w-4 h-4" />
				{#if !isMobile}Changes{/if}
			</button>

			<!-- Revert -->
			<button
				onclick={onRevert}
				class="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg text-status-warning hover:bg-status-warning/10 transition-all duration-200"
				title="Revert last commit"
			>
				<Undo2 class="w-4 h-4" />
				{#if !isMobile}Revert{/if}
			</button>

			<!-- Refresh -->
			<button
				onclick={onRefresh}
				disabled={isLoading}
				class="p-2 rounded-lg hover:bg-muted transition-all duration-200 text-muted-foreground"
				title={m.git_header_refresh()}
			>
				<RefreshCw class="w-4 h-4 {isLoading ? 'animate-spin' : ''}" />
			</button>
		{/if}
	</div>
</div>
