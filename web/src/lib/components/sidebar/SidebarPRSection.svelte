<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import GitPullRequest from '@lucide/svelte/icons/git-pull-request';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { getChatSessions, getPullRequests } from '$lib/context';
	import { cn } from '$lib/utils/cn';
	import SidebarPRItem from './SidebarPRItem.svelte';

	const pullRequests = getPullRequests();
	const chatSessions = getChatSessions();

	const projectPath = $derived(chatSessions.selectedChat?.projectPath ?? null);

	// Keeps the PR list scoped to the active chat's project.
	$effect(() => {
		pullRequests.setProject(projectPath);
	});

	const collapsed = $derived(pullRequests.collapsed);
</script>

{#if projectPath}
	<div class="flex-shrink-0 border-b border-border">
		<div class="flex items-center gap-1 px-2 py-1.5">
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-semibold text-foreground focus-visible:outline-none"
				onclick={() => pullRequests.toggleCollapsed()}
				aria-expanded={!collapsed}
			>
				{#if collapsed}
					<ChevronRight class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
				{:else}
					<ChevronDown class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
				{/if}
				<GitPullRequest class="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
				<span>Pull Requests</span>
				{#if pullRequests.pulls.length > 0}
					<span
						class="flex-shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-foreground"
					>
						{pullRequests.pulls.length}
					</span>
				{/if}
			</button>
			<button
				type="button"
				class="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				onclick={() => pullRequests.refresh()}
				aria-label="Refresh pull requests"
				title="Refresh pull requests"
			>
				<RefreshCw class={cn('h-3.5 w-3.5', pullRequests.isLoading && 'animate-spin')} />
			</button>
		</div>

		{#if !collapsed}
			<div class="max-h-64 overflow-y-auto px-1.5 pb-1.5">
				{#if pullRequests.isLoading && !pullRequests.hasLoaded}
					<div class="px-2 py-2 text-[11px] text-muted-foreground">Loading pull requests…</div>
				{:else if pullRequests.loadError}
					<div class="px-2 py-2 text-[11px] text-git-deleted">{pullRequests.loadError}</div>
				{:else if pullRequests.pulls.length === 0}
					<div class="px-2 py-2 text-[11px] text-muted-foreground">No open pull requests.</div>
				{:else}
					<div class="flex flex-col gap-0.5">
						{#each pullRequests.pulls as pr (pr.number)}
							<SidebarPRItem
								{pr}
								selected={pullRequests.selectedNumber === pr.number}
								onSelect={() => pullRequests.select(pr.number)}
							/>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
