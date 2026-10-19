<script lang="ts">
	import { untrack } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Search from '@lucide/svelte/icons/search';
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import {
		inboxEntryKey,
		type PullRequestInboxGroupId,
	} from '$lib/git/pull-requests/pull-request-inbox.js';
	import type { PullRequestReviewInboxEntry } from '$shared/pull-request-reviews';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import {
		containerPresentationForWidth,
		observeContainerWidth,
		type ContainerPresentation,
	} from '$lib/components/shared/container-presentation.js';
	import { registerNativeWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import PullRequestInboxRow from './PullRequestInboxRow.svelte';
	import PullRequestDetailPanel from './PullRequestDetailPanel.svelte';
	import PullRequestRepositoriesDialog from './PullRequestRepositoriesDialog.svelte';
	import PullRequestRepositoryDialog from './PullRequestRepositoryDialog.svelte';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';

	interface PullRequestsPanelProps {
		controller: PullRequestsStore;
		isMobile?: boolean;
		// Shows a review chat; on desktop beside this view.
		onOpenChat: (chatId: string) => void;
	}

	let { controller: pullRequests, isMobile = false, onOpenChat }: PullRequestsPanelProps = $props();

	const reviews = $derived(pullRequests.reviews);
	const groups = $derived(pullRequests.groups.filter((group) => group.entries.length > 0));
	const isFiltered = $derived(
		Boolean(pullRequests.query) || pullRequests.repositoryFilter !== null,
	);
	// Rows name their repository only when more than one is connected.
	const showsRepositoryNames = $derived(reviews.repositories.length > 1);
	const hasScanFailures = $derived(
		reviews.repositories.some((repository) => repository.scan.status !== 'ok'),
	);
	const hasSelection = $derived(pullRequests.hasSelection);
	const groupLabels: Record<PullRequestInboxGroupId, () => string> = {
		'needs-my-review': m.pull_request_inbox_needs_my_review,
		'authored-by-me': m.pull_request_inbox_authored_by_me,
		'needs-team-review': m.pull_request_inbox_needs_team_review,
		'other-open': m.pull_request_inbox_other_open,
	};
	let collapsedGroups = $state<Set<PullRequestInboxGroupId>>(new Set());
	let repositoriesOpen = $state(false);
	let connecting = $state(false);
	let currentTime = $state(new Date());

	const containerBreakpoints = { compactMinWidth: 720, wideMinWidth: 960 } as const;
	let containerWidth = $state(0);
	const observePanelWidth = observeContainerWidth((width) => {
		containerWidth = width;
	});
	const containerPresentation = $derived<ContainerPresentation>(
		isMobile ? 'narrow' : containerPresentationForWidth(containerWidth, containerBreakpoints),
	);
	let listViewportRef = $state<HTMLElement | null>(null);
	const listHidden = $derived(containerPresentation === 'narrow' && hasSelection);
	const detailHidden = $derived(containerPresentation === 'narrow' && !hasSelection);

	$effect(() => {
		const region = listViewportRef;
		if (!region) return;
		return registerNativeWorkspaceScrollRegion(region, 'contextual');
	});

	// Relative ages in the list stay current while the view is open.
	$effect(() => {
		const timer = setInterval(() => (currentTime = new Date()), 60_000);
		return () => clearInterval(timer);
	});

	// Loads the selection's detail and reloads its runs when the inbox snapshot changes.
	$effect(() => {
		void reviews.snapshot;
		void pullRequests.selectedKey;
		untrack(() => pullRequests.syncSelection());
	});

	// The least recent successful scan, so the caption never overstates freshness.
	const updatedAge = $derived.by(() => {
		const scannedAt = reviews.repositories
			.map((repository) => repository.scan.scannedAt)
			.filter((value): value is string => value !== null)
			.toSorted()[0];
		return formatRelativeTimestamp(scannedAt, currentTime);
	});

	function repositoryName(repositoryId: string): string {
		return showsRepositoryNames ? reviews.repositoryLabel(repositoryId) : '';
	}

	function toggleGroup(id: PullRequestInboxGroupId): void {
		const next = new Set(collapsedGroups);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		collapsedGroups = next;
	}

	// Desktop opens the pull request's review chat beside the inbox; mobile keeps the user here.
	function selectEntry(entry: PullRequestReviewInboxEntry): void {
		pullRequests.select(entry);
		const chatId = entry.latestRun?.chatAvailable ? entry.latestRun.chatId : null;
		if (chatId && !isMobile) onOpenChat(chatId);
	}
</script>

<div
	class="flex h-full min-w-0 flex-col"
	data-pr-panel
	data-pr-layout={containerPresentation}
	{@attach observePanelWidth}
>
	<div class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
		<h2 class="min-w-0 truncate text-base font-semibold text-foreground">
			{m.pull_requests_title()}
		</h2>
		<p
			class="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground"
			role="status"
			data-pr-inbox-freshness
		>
			{#if reviews.isScanning}
				{m.pull_request_inbox_checking()}
			{:else if updatedAge}
				<span title={updatedAge.tooltip}
					>{m.pull_request_inbox_updated({ age: updatedAge.label })}</span
				>
			{/if}
		</p>
		<button
			type="button"
			class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
			aria-label={m.pull_requests_refresh()}
			title={m.pull_requests_refresh()}
			disabled={reviews.repositories.length === 0 || reviews.isScanning}
			onclick={() => void pullRequests.scan()}
		>
			<RefreshCw
				class={cn('h-4 w-4', (reviews.isRefreshing || reviews.isScanning) && 'animate-spin')}
			/>
		</button>
		<button
			type="button"
			class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label={m.pull_request_repositories()}
			title={m.pull_request_repositories()}
			onclick={() => (repositoriesOpen = true)}
			data-pr-repositories-button
		>
			<Settings2 class="h-4 w-4" />
		</button>
	</div>
	{#if reviews.status === 'ready' && reviews.repositories.length === 0}
		<div class="flex min-h-0 flex-1 items-center justify-center p-6" data-pr-inbox-empty>
			<div class="flex max-w-sm flex-col items-center gap-2 text-center">
				<GitPullRequest class="h-8 w-8 text-muted-foreground" />
				<p class="text-sm font-medium text-foreground">{m.pull_request_inbox_empty_title()}</p>
				<p class="text-sm text-muted-foreground">{m.pull_request_inbox_no_repositories()}</p>
				<button
					type="button"
					class="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					onclick={() => (connecting = true)}
					data-pr-inbox-connect>{m.pull_request_repository_connect()}</button
				>
			</div>
		</div>
	{:else}
		<div class="flex min-h-0 min-w-0 flex-1">
			<div
				class={cn(
					'flex h-full min-h-0 flex-col border-border',
					containerPresentation === 'narrow' && 'w-full',
					containerPresentation === 'compact' && 'w-64 flex-shrink-0 border-r',
					containerPresentation === 'wide' && 'w-80 flex-shrink-0 border-r',
					listHidden && 'hidden',
				)}
				aria-hidden={listHidden}
				inert={listHidden}
				data-pr-list
			>
				<label
					class="mx-3 mt-3 mb-2 flex shrink-0 items-center gap-2 rounded-full bg-muted px-3 py-1.5"
				>
					<Search class="h-4 w-4 shrink-0 text-muted-foreground" />
					<input
						class="min-w-0 flex-1 bg-transparent text-base text-foreground pointer-fine:text-sm outline-none placeholder:text-muted-foreground"
						placeholder={m.pull_request_inbox_search()}
						aria-label={m.pull_request_inbox_search()}
						bind:value={pullRequests.query}
					/>
				</label>
				{#if reviews.repositories.length > 1}
					<div class="mx-3 mb-2">
						<select
							class="select-native w-full text-base pointer-fine:text-sm"
							aria-label={m.pull_request_inbox_repository_filter()}
							bind:value={pullRequests.repositoryFilter}
						>
							<option value={null}>{m.pull_request_inbox_all_repositories()}</option>
							{#each reviews.repositories as repository (repository.id)}
								<option value={repository.id}>{reviews.repositoryLabel(repository.id)}</option>
							{/each}
						</select>
					</div>
				{/if}
				<ScrollArea bind:viewportRef={listViewportRef} class="min-h-0 flex-1">
					<div class="flex flex-col gap-3 px-2 pb-3">
						{#if hasScanFailures}
							<p
								class="rounded-md border border-status-warning-border bg-status-warning p-2 text-xs text-status-warning-foreground"
								role="status"
							>
								{m.pull_request_inbox_scan_attention()}
							</p>
						{/if}
						{#if reviews.status === 'loading' || reviews.status === 'idle'}
							<p class="px-2 py-3 text-xs text-muted-foreground">{m.pull_requests_loading()}</p>
						{:else if reviews.status === 'error'}
							<div class="px-2 py-3 text-xs text-muted-foreground">
								<p>{reviews.error}</p>
								<button
									type="button"
									class="mt-2 rounded-md border border-border px-2.5 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
									onclick={() => void reviews.refresh()}>{m.common_retry()}</button
								>
							</div>
						{:else if groups.length === 0 && !isFiltered}
							<p class="px-2 py-3 text-sm text-muted-foreground">{m.pull_requests_none()}</p>
						{:else if groups.length === 0}
							<div class="px-2 py-3 text-sm text-muted-foreground">
								<p>{m.pull_request_inbox_no_matches()}</p>
								<button
									type="button"
									class="mt-2 rounded-md border border-border px-3 py-1.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
									onclick={() => {
										pullRequests.query = '';
										pullRequests.repositoryFilter = null;
									}}
								>
									{m.pull_request_inbox_clear_filters()}
								</button>
							</div>
						{:else}
							{#each groups as group (group.id)}
								{@const collapsed = collapsedGroups.has(group.id)}
								<section data-pr-inbox-group={group.id}>
									<div class="flex items-center gap-1 px-2 py-1">
										<button
											type="button"
											class="flex min-w-0 flex-1 items-center gap-1 rounded text-left text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
											aria-expanded={!collapsed}
											onclick={() => toggleGroup(group.id)}
										>
											<span class="truncate">{groupLabels[group.id]()}</span>
											<ChevronDown
												class={cn(
													'h-3.5 w-3.5 shrink-0 transition-transform',
													collapsed && '-rotate-90',
												)}
											/>
											<span class="ml-auto text-xs tabular-nums">{group.entries.length}</span>
										</button>
									</div>
									{#if !collapsed}
										<div class="flex flex-col gap-0.5">
											{#each group.entries as entry (inboxEntryKey(entry))}
												<svelte:boundary>
													<PullRequestInboxRow
														{entry}
														repositoryName={repositoryName(entry.repositoryId)}
														selected={pullRequests.selectedKey === inboxEntryKey(entry)}
														{currentTime}
														onSelect={() => selectEntry(entry)}
													/>
													{#snippet failed()}
														<p class="px-2 text-xs text-muted-foreground">
															{m.pull_request_load_failed()}
														</p>
													{/snippet}
												</svelte:boundary>
											{/each}
										</div>
									{/if}
								</section>
							{/each}
						{/if}
					</div>
				</ScrollArea>
			</div>
			<div
				class={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col', detailHidden && 'hidden')}
				aria-hidden={detailHidden}
				inert={detailHidden}
				data-pr-detail
			>
				{#if hasSelection}
					{#if containerPresentation === 'narrow'}
						<button
							type="button"
							class="flex flex-shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none"
							onclick={() => pullRequests.clearSelection()}
						>
							<ArrowLeft class="h-3.5 w-3.5" />
							{m.pull_requests_all()}
						</button>
					{/if}
					<div class="min-h-0 flex-1">
						<PullRequestDetailPanel
							controller={pullRequests}
							{currentTime}
							{onOpenChat}
							onClose={containerPresentation === 'narrow'
								? undefined
								: () => pullRequests.clearSelection()}
						/>
					</div>
				{:else}
					<div
						class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground"
					>
						<GitPullRequest class="h-8 w-8 opacity-40" />
						<p class="text-sm">{m.pull_requests_select()}</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if repositoriesOpen}
	<PullRequestRepositoriesDialog
		{reviews}
		{onOpenChat}
		onClose={() => (repositoriesOpen = false)}
	/>
{/if}

{#if connecting}
	<PullRequestRepositoryDialog
		repository={null}
		onSave={(input) => reviews.connect(input)}
		onClose={() => (connecting = false)}
	/>
{/if}
