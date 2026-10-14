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

	interface PullRequestsPanelProps {
		controller: PullRequestsStore;
		isMobile?: boolean;
		onSendToChat: (message: string) => Promise<boolean>;
		onNavigateToChat: () => void;
		// Shows a review chat; on desktop beside this view.
		onOpenChat: (chatId: string) => void;
	}

	let {
		controller: pullRequests,
		isMobile = false,
		onSendToChat,
		onNavigateToChat,
		onOpenChat,
	}: PullRequestsPanelProps = $props();

	const reviews = $derived(pullRequests.reviews);
	const groups = $derived(pullRequests.groups);
	const hasSelection = $derived(pullRequests.hasSelection);
	const groupLabels: Record<PullRequestInboxGroupId, () => string> = {
		'needs-my-review': m.pull_request_inbox_needs_my_review,
		'authored-by-me': m.pull_request_inbox_authored_by_me,
		'needs-team-review': m.pull_request_inbox_needs_team_review,
		'all-open': m.pull_request_inbox_all_open,
	};
	let collapsedGroups = $state<Set<PullRequestInboxGroupId>>(new Set());
	let repositoriesOpen = $state(false);
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

	function repositoryName(repositoryId: string): string {
		return reviews.repository(repositoryId)?.nameWithOwner ?? '';
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
	<div class="flex h-full min-h-0 min-w-0">
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
			<div class="flex shrink-0 items-center gap-1 px-3 pt-3 pb-2">
				<h2 class="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
					{m.pull_requests_title()}
				</h2>
				<button
					type="button"
					class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label={m.pull_requests_refresh()}
					title={m.pull_requests_refresh()}
					disabled={reviews.repositories.length === 0}
					onclick={() => void reviews.scan()}
				>
					<RefreshCw class={cn('h-4 w-4', reviews.isRefreshing && 'animate-spin')} />
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
			<label class="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-full bg-muted px-3 py-1.5">
				<Search class="h-4 w-4 shrink-0 text-muted-foreground" />
				<input
					class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
					placeholder={m.pull_request_inbox_search()}
					aria-label={m.pull_request_inbox_search()}
					bind:value={pullRequests.query}
				/>
			</label>
			<ScrollArea bind:viewportRef={listViewportRef} class="min-h-0 flex-1">
				<div class="flex flex-col gap-3 px-2 pb-3">
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
					{:else if reviews.repositories.length === 0}
						<div class="px-2 py-3 text-sm text-muted-foreground" data-pr-inbox-empty>
							<p>{m.pull_request_inbox_no_repositories()}</p>
							<button
								type="button"
								class="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
								onclick={() => (repositoriesOpen = true)}>{m.pull_request_repository_connect()}</button
							>
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
										<ChevronDown class={cn('h-3.5 w-3.5 shrink-0 transition-transform', collapsed && '-rotate-90')} />
										<span class="ml-auto text-xs tabular-nums">{group.entries.length}</span>
									</button>
									{#if group.id === 'all-open' && reviews.repositories.length > 1}
										<select
											class="select-native max-w-32 text-xs"
											aria-label={m.pull_request_inbox_repository_filter()}
											bind:value={pullRequests.repositoryFilter}
										>
											<option value={null}>{m.pull_request_inbox_all_repositories()}</option>
											{#each reviews.repositories as repository (repository.id)}
												<option value={repository.id}>{repository.nameWithOwner}</option>
											{/each}
										</select>
									{/if}
								</div>
								{#if !collapsed}
									{#if group.entries.length === 0}
										<p class="px-2 pb-1 text-sm text-muted-foreground/80">{m.pull_requests_none()}</p>
									{:else}
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
														<p class="px-2 text-xs text-muted-foreground">{m.pull_request_load_failed()}</p>
													{/snippet}
												</svelte:boundary>
											{/each}
										</div>
									{/if}
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
						{onSendToChat}
						{onOpenChat}
						onClose={() => pullRequests.clearSelection()}
						onAfterSend={onNavigateToChat}
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
</div>

{#if repositoriesOpen}
	<PullRequestRepositoriesDialog {reviews} {currentTime} {onOpenChat} onClose={() => (repositoriesOpen = false)} />
{/if}
