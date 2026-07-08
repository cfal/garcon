<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import CircleDot from '@lucide/svelte/icons/circle-dot';
	import type { PullRequestDetail } from '$lib/api/pull-requests';
	import {
		checksStateClass,
		checksStateLabel,
		overallChecksState,
		prStateBadge,
		reviewDecisionBadge,
	} from './pr-display';
	import Markdown from '$lib/components/chat/Markdown.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Popover from '$lib/components/ui/popover';

	interface PullRequestHeaderProps {
		pr: PullRequestDetail;
		isReviewing: boolean;
		onReview: () => void;
		onRefresh: () => void;
		onClose: () => void;
	}

	let { pr, isReviewing, onReview, onRefresh, onClose }: PullRequestHeaderProps = $props();

	const stateBadge = $derived(prStateBadge(pr.state, pr.isDraft));
	const decisionBadge = $derived(reviewDecisionBadge(pr.reviewDecision));
	const checksState = $derived(overallChecksState(pr.checks));
	const checksLabel = $derived(checksStateLabel(checksState));
	const mergeableLabel = $derived(
		pr.mergeable === 'conflicting'
			? 'Conflicts'
			: pr.mergeable === 'mergeable'
				? 'No conflicts'
				: '',
	);
	const hasBody = $derived(pr.body.trim().length > 0);
</script>

<div class="border-b border-border bg-card px-3 py-2.5">
	<div class="flex items-start gap-2">
		<span
			class="mt-0.5 flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold {stateBadge.class}"
		>
			{stateBadge.label}
		</span>
		<h2 class="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground">
			<span class="text-muted-foreground">#{pr.number}</span>
			{pr.title}
		</h2>
		{#if hasBody}
			<Popover.Root>
				<Popover.Trigger>
					<Button
						variant="ghost"
						size="icon-sm"
						class="flex-shrink-0 text-muted-foreground"
						aria-label="Pull request description"
						title="Description"
					>
						<EllipsisVertical class="h-4 w-4" />
					</Button>
				</Popover.Trigger>
				<Popover.Content class="w-96 max-w-[90vw] p-0" align="end" sideOffset={8}>
					<div class="max-h-[24rem] overflow-y-auto px-3 py-2.5">
						<div class="mb-1 text-[10px] font-medium uppercase text-muted-foreground">Description</div>
						<Markdown source={pr.body} class="markdown-body prose prose-sm max-w-none text-xs" />
					</div>
				</Popover.Content>
			</Popover.Root>
		{/if}
		<button
			type="button"
			class="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			onclick={onClose}
			aria-label="Close pull request"
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="mt-1 truncate text-xs text-muted-foreground">
		<span class="font-medium text-foreground">{pr.author}</span>
		wants to merge
		<span class="font-mono">{pr.headRefName}</span>
		→
		<span class="font-mono">{pr.baseRefName}</span>
	</div>

	<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
		{#if checksLabel}
			<span class="inline-flex items-center gap-1 {checksStateClass(checksState)}">
				{#if checksState === 'passing'}
					<CircleCheck class="h-3.5 w-3.5" />
				{:else if checksState === 'failing'}
					<CircleX class="h-3.5 w-3.5" />
				{:else}
					<CircleDot class="h-3.5 w-3.5" />
				{/if}
				{checksLabel}
			</span>
		{/if}
		{#if decisionBadge}
			<span class="rounded px-1.5 py-0.5 text-[11px] font-medium {decisionBadge.class}"
				>{decisionBadge.label}</span
			>
		{/if}
		{#if mergeableLabel}
			<span
				class="text-xs {pr.mergeable === 'conflicting' ? 'text-git-deleted' : 'text-muted-foreground'}"
				>{mergeableLabel}</span
			>
		{/if}
		<span class="text-muted-foreground">
			<span class="font-medium text-git-added">+{pr.additions}</span>
			<span class="font-medium text-git-deleted">−{pr.deletions}</span>
			· {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
		</span>
	</div>

	<div class="mt-2.5 flex items-center gap-2">
		<button
			type="button"
			class="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
			onclick={onReview}
			disabled={isReviewing}
		>
			<Sparkles class="h-3.5 w-3.5" />
			{isReviewing ? 'Sent to agent' : 'Review this PR'}
		</button>
		<button
			type="button"
			class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			onclick={onRefresh}
		>
			<RefreshCw class="h-3.5 w-3.5" />
			Refresh
		</button>
		<a
			href={pr.url}
			target="_blank"
			rel="noreferrer noopener"
			class="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
		>
			<ExternalLink class="h-3.5 w-3.5" />
			GitHub
		</a>
	</div>
</div>
