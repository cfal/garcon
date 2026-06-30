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
	import * as Popover from '$lib/components/ui/popover';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
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
		onSwitchBranch: (branch: string) => void | Promise<void>;
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

	let searchInput = $state<HTMLInputElement | null>(null);
	let searchQuery = $state('');
	let pendingSwitchBranch = $state<string | null>(null);
	let isSwitchingBranch = $state(false);

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
			'w-72 max-w-[calc(100vw-1rem)] max-h-[min(28rem,var(--bits-popover-content-available-height))] overflow-hidden rounded-lg border-border p-0 shadow-lg',
			menuClass,
		),
	);
	const searchInputClass = $derived(
		cn(
			'w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-accent',
			isMobile ? 'text-[16px] leading-6' : 'text-xs',
		),
	);

	$effect(() => {
		if (isOpen) {
			if (!isMobile) queueMicrotask(() => searchInput?.focus());
			return;
		}
		searchQuery = '';
	});

	function handleOpenChange(open: boolean): void {
		if (open === isOpen) return;
		if (open) onToggle();
		else onClose();
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		onClose();
	}

	function requestSwitchBranch(branch: string): void {
		onClose();
		if (branch === currentBranchLabel) return;
		pendingSwitchBranch = branch;
	}

	async function confirmSwitchBranch(): Promise<void> {
		const branch = pendingSwitchBranch;
		if (!branch || isSwitchingBranch) return;

		isSwitchingBranch = true;
		try {
			await onSwitchBranch(branch);
		} finally {
			isSwitchingBranch = false;
			pendingSwitchBranch = null;
		}
	}

	function cancelSwitchBranch(): void {
		if (isSwitchingBranch) return;
		pendingSwitchBranch = null;
	}
</script>

{#snippet branchSearchBox()}
	<div class="relative">
		<Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
		<input
			bind:this={searchInput}
			type="text"
			value={searchQuery}
			oninput={(event) => {
				searchQuery = event.currentTarget.value;
			}}
			placeholder={m.git_branch_selector_find_branch()}
			class={searchInputClass}
			aria-label={m.git_branch_selector_find_branch_label()}
			role="combobox"
			aria-controls={listboxId}
			aria-expanded="true"
			aria-autocomplete="list"
		/>
	</div>
{/snippet}

{#snippet createBranchAction()}
	<div class="border-t border-border py-1">
		<button
			type="button"
			onclick={() => {
				onCreateBranch?.();
				onClose();
			}}
			class="w-full text-left px-4 py-2 text-sm hover:bg-accent flex items-center space-x-2"
		>
			<Plus class="w-3.5 h-3.5" />
			<span>{m.git_header_create_branch()}</span>
		</button>
	</div>
{/snippet}

<Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
	<Popover.Trigger
		type="button"
		aria-haspopup="listbox"
		aria-expanded={isOpen}
		aria-label={m.git_branch_selector_trigger_label({ branch: currentBranchLabel })}
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
	</Popover.Trigger>

	<Popover.Content
			class={resolvedMenuClass}
		{align}
		{side}
		sideOffset={4}
		collisionPadding={8}
		sticky="always"
		onkeydown={handleMenuKeydown}
		role="dialog"
		aria-label={m.git_branch_selector_switch_branches()}
		tabindex={-1}
	>
		<div class="flex max-h-[inherit] min-h-0 flex-col overflow-hidden">
			<div class="shrink-0 border-b border-border px-3 py-2">
				<div class="{isMobile ? '' : 'mb-2'} text-xs font-medium text-foreground">
					{m.git_branch_selector_switch_branches()}
				</div>
				{#if !isMobile}{@render branchSearchBox()}{/if}
			</div>
			<div
				id={listboxId}
				class="min-h-0 flex-1 overflow-y-auto py-1"
				role="listbox"
				aria-label={m.git_branch_selector_branches_label()}
			>
				{#if isLoading}
					<div class="flex items-center justify-center gap-2 px-3 py-3 text-xs text-muted-foreground">
						<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						<span>{m.status_loading()}</span>
					</div>
				{:else if filteredBranches.length === 0}
					<div class="px-3 py-3 text-center text-xs text-muted-foreground">
						{m.git_branch_selector_no_branches_found()}
					</div>
				{/if}
				{#if !isLoading}
					{#each filteredBranches as branch (branch)}
						<button
							type="button"
							onclick={() => requestSwitchBranch(branch)}
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
				{@render createBranchAction()}
			{/if}
			{#if isMobile}
				<div class="border-t border-border px-3 py-2">
					{@render branchSearchBox()}
				</div>
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>

{#if pendingSwitchBranch}
	<Dialog.Root
		open={true}
		onOpenChange={(open) => {
			if (!open) cancelSwitchBranch();
		}}
	>
		<Dialog.Content showCloseButton={!isSwitchingBranch}>
			<Dialog.Header>
				<div class="flex items-center">
					<div class="mr-3 rounded-full bg-diff-modified p-2">
						<GitBranch class="h-5 w-5 text-diff-modified-foreground" />
					</div>
					<Dialog.Title>
						{m.git_branch_switch_title({ branch: pendingSwitchBranch })}
					</Dialog.Title>
				</div>
				<Dialog.Description>
					{m.git_branch_switch_description({ branch: pendingSwitchBranch })}
				</Dialog.Description>
			</Dialog.Header>

			<Dialog.Footer>
				<button
					type="button"
					onclick={cancelSwitchBranch}
					disabled={isSwitchingBranch}
					class="rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
				>
					{m.git_confirm_cancel()}
				</button>
				<button
					type="button"
					onclick={confirmSwitchBranch}
					disabled={isSwitchingBranch}
					class="flex items-center gap-2 rounded-md bg-git-action-commit px-4 py-2 text-sm text-git-action-foreground hover:bg-git-action-commit-hover disabled:cursor-not-allowed disabled:opacity-70"
				>
					{#if isSwitchingBranch}
						<LoaderCircle class="h-4 w-4 animate-spin" />
						<span>{m.git_branch_switch_switching()}</span>
					{:else}
						<GitBranch class="h-4 w-4" />
						<span>{m.git_branch_switch_confirm()}</span>
					{/if}
				</button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
