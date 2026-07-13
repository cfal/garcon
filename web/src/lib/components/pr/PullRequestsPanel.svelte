<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { getPullRequests } from '$lib/context';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { cn } from '$lib/utils/cn';
	import PullRequestListItem from './PullRequestListItem.svelte';
	import PullRequestDetailPanel from './PullRequestDetailPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface PullRequestsPanelProps {
		projectPath: string;
		effectiveProjectKey?: string;
		isMobile?: boolean;
		isVisible?: boolean;
		onSendToChat: (message: string) => Promise<boolean>;
		onNavigateToChat: () => void;
	}

	let {
		projectPath,
		effectiveProjectKey = projectPath,
		isMobile = false,
		onSendToChat,
		onNavigateToChat,
	}: PullRequestsPanelProps = $props();

	const pullRequests = getPullRequests();

	// Scopes the list to this workspace's project and loads it on first open.
	$effect(() => {
		pullRequests.setProject(projectPath, effectiveProjectKey);
	});

	const hasSelection = $derived(pullRequests.hasSelection);
</script>

<div class="flex h-full min-h-0">
	<!-- List column -->
	<div
		class={cn(
			'flex h-full min-h-0 w-full flex-col border-border sm:w-80 sm:flex-shrink-0 sm:border-r',
			isMobile && hasSelection && 'hidden',
		)}
	>
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<GitPullRequest class="h-4 w-4 flex-shrink-0 text-muted-foreground" />
			<span class="text-sm font-semibold text-foreground">{m.pull_requests_title()}</span>
			{#if pullRequests.pulls.length > 0}
				<span class="rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-foreground"
					>{pullRequests.pulls.length}</span
				>
			{/if}
			<button
				type="button"
				class="ml-auto flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={() => pullRequests.refresh()}
				aria-label={m.pull_requests_refresh()}
				title={m.pull_requests_refresh()}
			>
				<RefreshCw class={cn('h-4 w-4', pullRequests.isLoading && 'animate-spin')} />
			</button>
		</div>
		<ScrollArea class="min-h-0 flex-1">
			<div class="flex flex-col gap-1 p-2">
				{#if pullRequests.isLoading && !pullRequests.hasLoaded}
					<div class="px-2 py-3 text-xs text-muted-foreground">{m.pull_requests_loading()}</div>
				{:else if pullRequests.loadError}
					<div class="px-2 py-3 text-xs text-git-deleted">{pullRequests.loadError}</div>
				{:else if pullRequests.pulls.length === 0}
					<div class="px-2 py-3 text-xs text-muted-foreground">{m.pull_requests_none()}</div>
				{:else}
					{#each pullRequests.pulls as pr (pr.number)}
						<PullRequestListItem
							{pr}
							selected={pullRequests.selectedNumber === pr.number}
							onSelect={() => pullRequests.select(pr.number)}
						/>
					{/each}
				{/if}
			</div>
		</ScrollArea>
	</div>

	<!-- Detail column -->
	<div class={cn('flex h-full min-h-0 flex-1 flex-col', isMobile && !hasSelection && 'hidden')}>
		{#if hasSelection}
			{#if isMobile}
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
					{onSendToChat}
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
