<script lang="ts">
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import type { PullRequestsStore } from '$lib/stores/pull-requests.svelte.js';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { cn } from '$lib/utils/cn';
	import PullRequestListItem from './PullRequestListItem.svelte';
	import PullRequestDetailPanel from './PullRequestDetailPanel.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import ResponsiveSurfaceActions, {
		type ResponsiveSurfaceAction,
	} from '$lib/components/shared/ResponsiveSurfaceActions.svelte';
	import {
		containerPresentationForWidth,
		observeContainerWidth,
		type ContainerPresentation,
	} from '$lib/components/shared/container-presentation.js';

	interface PullRequestsPanelProps {
		controller: PullRequestsStore;
		isMobile?: boolean;
		onSendToChat: (message: string) => Promise<boolean>;
		onNavigateToChat: () => void;
		onRetryCapability: () => void;
	}

	let {
		controller: pullRequests,
		isMobile = false,
		onSendToChat,
		onNavigateToChat,
		onRetryCapability,
	}: PullRequestsPanelProps = $props();

	const projectPath = $derived(pullRequests.projectPath);
	const effectiveProjectKey = $derived(pullRequests.effectiveProjectKey);

	const hasSelection = $derived(pullRequests.hasSelection);
	const toolbarActions = $derived<ResponsiveSurfaceAction[]>([
		{
			id: 'refresh',
			label: m.pull_requests_refresh(),
			icon: RefreshCw,
			iconClass: pullRequests.isLoading ? 'animate-spin' : undefined,
			onclick: () => pullRequests.refresh(),
			disabled: pullRequests.capabilityState !== 'available',
			priority: 0,
		},
	]);
	const containerBreakpoints = { compactMinWidth: 720, wideMinWidth: 960 } as const;
	let containerWidth = $state(0);
	const observePanelWidth = observeContainerWidth((width) => {
		containerWidth = width;
	});
	let containerPresentation = $derived<ContainerPresentation>(
		isMobile ? 'narrow' : containerPresentationForWidth(containerWidth, containerBreakpoints),
	);
</script>

<div
	class="flex h-full min-w-0 flex-col"
	data-pr-panel
	data-pr-layout={containerPresentation}
	{@attach observePanelWidth}
>
	<div
		class="surface-toolbar flex h-10 shrink-0 items-center gap-2 border-b border-border px-3"
		style="container-name: surface-toolbar; container-type: inline-size;"
	>
		<GitPullRequest class="h-4 w-4 shrink-0 text-muted-foreground" />
		<span class="min-w-0 truncate text-sm font-semibold text-foreground"
			>{m.pull_requests_title()}</span
		>
		{#if pullRequests.pulls.length > 0}
			<span class="rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-foreground"
				>{pullRequests.pulls.length}</span
			>
		{/if}
		<ResponsiveSurfaceActions
			actions={toolbarActions}
			menuLabel={m.workspace_surface_actions()}
			class="ml-auto"
		/>
	</div>
	<div class="min-h-0 flex-1">
		{#if pullRequests.capabilityState === 'pending'}
			<div class="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
				{m.workspace_pull_requests_checking()}
			</div>
		{:else if pullRequests.capabilityState === 'unavailable'}
			<div class="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
				<div class="max-w-sm">
					<p>{m.workspace_pull_requests_unavailable()}</p>
					<button
						type="button"
						class="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
						onclick={onRetryCapability}>{m.common_retry()}</button
					>
				</div>
			</div>
		{:else if !projectPath || !effectiveProjectKey}
			<div class="grid h-full place-items-center px-6 text-center text-sm text-muted-foreground">
				{m.git_panel_select_project()}
			</div>
		{:else}
			<div class="flex h-full min-h-0 min-w-0">
				<div
					class={cn(
						'flex h-full min-h-0 flex-col border-border',
						containerPresentation === 'narrow' && 'w-full',
						containerPresentation === 'compact' && 'w-60 flex-shrink-0 border-r',
						containerPresentation === 'wide' && 'w-80 flex-shrink-0 border-r',
						containerPresentation === 'narrow' && hasSelection && 'hidden',
					)}
					data-pr-list
				>
					<ScrollArea class="min-h-0 flex-1">
						<div class="flex flex-col gap-1 p-2">
							{#if pullRequests.isLoading && !pullRequests.hasLoaded}
								<div class="px-2 py-3 text-xs text-muted-foreground">
									{m.pull_requests_loading()}
								</div>
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
				<div
					class={cn(
						'flex h-full min-h-0 min-w-0 flex-1 flex-col',
						containerPresentation === 'narrow' && !hasSelection && 'hidden',
					)}
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
		{/if}
	</div>
</div>
