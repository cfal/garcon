<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import type {
		PullRequestDetailTab,
		PullRequestsStore,
	} from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import { cn } from '$lib/utils/cn';
	import PullRequestHeader from './PullRequestHeader.svelte';
	import PullRequestChangesTab from './PullRequestChangesTab.svelte';
	import PullRequestChecksTab from './PullRequestChecksTab.svelte';
	import PullRequestReviewTab from './PullRequestReviewTab.svelte';

	interface PullRequestDetailPanelProps {
		controller: PullRequestsStore;
		currentTime: Date;
		onOpenChat: (chatId: string) => void;
		// Absent in narrow layouts, where the back link closes the detail.
		onClose?: () => void;
	}

	let {
		controller: pullRequests,
		currentTime,
		onOpenChat,
		onClose,
	}: PullRequestDetailPanelProps = $props();
	const entry = $derived(pullRequests.selectedEntry);
	const changes = $derived(pullRequests.changesView);
	const checks = $derived(pullRequests.checksView);
	const tabs: { id: PullRequestDetailTab; label: () => string }[] = [
		{ id: 'review', label: m.pull_request_tab_review },
		{ id: 'changes', label: m.pull_request_tab_changes },
		{ id: 'checks', label: m.pull_request_tab_checks },
	];

	// Arrow keys move between tabs, as the tab pattern expects.
	function handleTabKeydown(event: KeyboardEvent, index: number): void {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
		pullRequests.tab = next.id;
		(event.currentTarget as HTMLElement).parentElement
			?.querySelector<HTMLElement>(`[data-pr-tab="${next.id}"]`)
			?.focus();
	}
</script>

{#snippet retryButton()}
	<button
		type="button"
		class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		onclick={() => pullRequests.refresh()}
	>
		{m.common_retry()}
	</button>
{/snippet}

<!-- The last loaded content stays below this notice, so a failed refresh never reads as current. -->
{#snippet refreshFailure(message: string)}
	<div
		class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground"
		role="status"
		data-pr-refresh-failure
	>
		<TriangleAlert class="h-3.5 w-3.5 shrink-0 text-git-deleted" />
		<p class="min-w-0 flex-1">
			<span>{m.pull_request_refresh_failed()}</span>
			<span>{message}</span>
		</p>
		{@render retryButton()}
	</div>
{/snippet}

{#snippet unavailable(part: { kind: 'loading' } | { kind: 'failed'; error: string })}
	{#if part.kind === 'loading'}
		<div class="flex h-full items-center justify-center text-muted-foreground">
			<LoaderCircle class="h-5 w-5 animate-spin" />
		</div>
	{:else}
		<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
			<TriangleAlert class="h-6 w-6 text-git-deleted" />
			<p class="text-sm text-muted-foreground">{part.error}</p>
			{@render retryButton()}
		</div>
	{/if}
{/snippet}

<div class="flex h-full flex-col bg-background">
	{#if entry}
		<PullRequestHeader
			pull={entry.pull}
			repositoryName={pullRequests.selectedRepository
				? pullRequests.reviews.repositoryLabel(pullRequests.selectedRepository.id)
				: ''}
			body={pullRequests.status.value?.body ?? ''}
			{currentTime}
			refreshing={pullRequests.isRefreshing}
			onRefresh={() => pullRequests.refresh()}
			{onClose}
		/>
		<div class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5" role="tablist">
			{#each tabs as tab, index (tab.id)}
				{@const selected = pullRequests.tab === tab.id}
				<button
					type="button"
					role="tab"
					aria-selected={selected}
					tabindex={selected ? 0 : -1}
					class={cn(
						'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
						selected
							? 'bg-muted font-medium text-foreground'
							: 'text-muted-foreground hover:text-foreground',
					)}
					data-pr-tab={tab.id}
					onclick={() => (pullRequests.tab = tab.id)}
					onkeydown={(event) => handleTabKeydown(event, index)}
				>
					{tab.label()}
					{#if tab.id === 'changes'}
						<span class="text-xs tabular-nums">
							<span class="text-git-added">+{entry.pull.additions.toLocaleString()}</span>
							<span class="text-git-deleted">−{entry.pull.deletions.toLocaleString()}</span>
						</span>
					{/if}
				</button>
			{/each}
		</div>
		<div class="flex min-h-0 flex-1 flex-col" role="tabpanel">
			{#if pullRequests.tab === 'review'}
				<PullRequestReviewTab controller={pullRequests} {currentTime} {onOpenChat} />
			{:else if pullRequests.tab === 'changes'}
				{#if changes.kind === 'ready'}
					{#if changes.refreshError}{@render refreshFailure(changes.refreshError)}{/if}
					<PullRequestChangesTab diff={changes.value.diff} threads={changes.value.threads} />
				{:else}
					{@render unavailable(changes)}
				{/if}
			{:else if checks.kind === 'ready'}
				{#if checks.refreshError}{@render refreshFailure(checks.refreshError)}{/if}
				<PullRequestChecksTab checks={checks.value} />
			{:else}
				{@render unavailable(checks)}
			{/if}
		</div>
	{/if}
</div>
