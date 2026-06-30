<script module lang="ts">
	let nextBranchSelectorId = 0;
</script>

<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import type { GitRemoteStatus } from '$lib/api/git';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';

	type DropdownSide = 'top' | 'bottom';
	type DropdownAlign = 'start' | 'end';

	interface Props {
		currentBranch: string;
		branches: string[];
		remoteStatus?: GitRemoteStatus | null;
		isOpen: boolean;
		isLoading?: boolean;
		isMobile?: boolean;
		side?: DropdownSide;
		align?: DropdownAlign;
		showCreateBranch?: boolean;
		triggerClass?: string;
		iconClass?: string;
		labelClass?: string;
		chevronClass?: string;
		menuClass?: string;
		onToggle: () => void;
		onClose: () => void;
		onCreateBranch?: () => void;
		onSwitchBranch: (branch: string) => void;
	}

	let {
		currentBranch,
		branches,
		remoteStatus = null,
		isOpen,
		isLoading = false,
		isMobile = false,
		side = 'bottom',
		align = 'start',
		showCreateBranch = true,
		triggerClass,
		iconClass,
		labelClass,
		chevronClass,
		menuClass,
		onToggle,
		onClose,
		onCreateBranch,
		onSwitchBranch,
	}: Props = $props();

	let containerEl = $state<HTMLDivElement | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);
	let searchQuery = $state('');

	const listboxId = `git-branch-listbox-${++nextBranchSelectorId}`;
	const currentBranchLabel = $derived(currentBranch || remoteStatus?.branch || 'Branch');
	const filteredBranches = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return branches;
		return branches.filter((branch) => branch.toLowerCase().includes(query));
	});
	const resolvedTriggerClass = $derived(
		cn(
			'min-w-0 flex items-center hover:bg-accent rounded-lg transition-colors duration-150',
			isMobile ? 'gap-1.5 px-2 py-1' : 'gap-1.5 px-3 py-1.5',
			triggerClass,
		),
	);
	const resolvedIconClass = $derived(cn('text-muted-foreground w-4 h-4', iconClass));
	const resolvedLabelClass = $derived(
		cn('text-sm font-medium truncate', isMobile ? 'max-w-[6rem]' : 'max-w-[140px]', labelClass),
	);
	const resolvedChevronClass = $derived(
		cn(
			'w-3.5 h-3.5 text-muted-foreground transition-transform',
			isOpen ? 'rotate-180' : '',
			chevronClass,
		),
	);
	const resolvedMenuClass = $derived(
		cn(
			'absolute w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-lg z-50',
			side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
			align === 'end' ? 'right-0' : 'left-0',
			menuClass,
		),
	);

	function handleClickOutside(event: MouseEvent): void {
		const target = event.target;
		if (containerEl && target instanceof Node && !containerEl.contains(target)) {
			onClose();
		}
	}

	$effect(() => {
		if (isOpen) {
			document.addEventListener('mousedown', handleClickOutside);
			queueMicrotask(() => searchInput?.focus());
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
		searchQuery = '';
	});

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		onClose();
	}
</script>

<div class="relative" bind:this={containerEl}>
	<button
		type="button"
		onclick={onToggle}
		aria-haspopup="listbox"
		aria-expanded={isOpen}
		aria-label={`Switch branch, current branch ${currentBranchLabel}`}
		class={resolvedTriggerClass}
		title={currentBranchLabel}
	>
		<GitBranch class={resolvedIconClass} />
		<span class={resolvedLabelClass}>{currentBranchLabel}</span>
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
		<ChevronDown class={resolvedChevronClass} />
	</button>

	{#if isOpen}
		<div
			class={resolvedMenuClass}
			onkeydown={handleMenuKeydown}
			role="dialog"
			aria-label="Switch branches"
			tabindex="-1"
		>
			<div class="border-b border-border px-3 py-2">
				<div class="mb-2 text-xs font-medium text-foreground">Switch branches</div>
				<div class="relative">
					<Search
						class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						bind:this={searchInput}
						type="text"
						value={searchQuery}
						oninput={(event) => {
							searchQuery = event.currentTarget.value;
						}}
						placeholder="Find a branch..."
						class="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent"
						aria-label="Find a branch"
						role="combobox"
						aria-controls={listboxId}
						aria-expanded="true"
						aria-autocomplete="list"
					/>
				</div>
			</div>
			<div class="border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
				Branches
			</div>
			<div id={listboxId} class="max-h-64 overflow-y-auto py-1" role="listbox" aria-label="Branches">
				{#if isLoading}
					<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-muted-foreground">
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						<span>{m.status_loading()}</span>
					</div>
				{:else if filteredBranches.length === 0}
					<div class="px-3 py-3 text-center text-xs text-muted-foreground">
						No branches found.
					</div>
				{/if}
				{#if !isLoading}
					{#each filteredBranches as branch (branch)}
						<button
							type="button"
							onclick={() => onSwitchBranch(branch)}
							role="option"
							aria-selected={branch === currentBranchLabel}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent {branch ===
							currentBranchLabel
								? 'bg-accent/50 font-medium'
								: 'text-muted-foreground'}"
						>
							<span class="flex h-4 w-4 shrink-0 items-center justify-center">
								{#if branch === currentBranchLabel}
									<Check class="h-3.5 w-3.5 text-status-success-foreground" />
								{/if}
							</span>
							<span class="min-w-0 truncate">{branch}</span>
						</button>
					{/each}
				{/if}
			</div>
			{#if showCreateBranch && onCreateBranch}
				<div class="border-t border-border py-1">
					<button
						type="button"
						onclick={() => {
							onCreateBranch();
							onClose();
						}}
						class="w-full text-left px-4 py-2 text-sm hover:bg-accent flex items-center space-x-2"
					>
						<Plus class="w-3.5 h-3.5" />
						<span>{m.git_header_create_branch()}</span>
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
