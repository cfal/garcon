<script lang="ts">
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import Send from '@lucide/svelte/icons/send';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Square from '@lucide/svelte/icons/square';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Markdown from '$lib/components/rich-text/Markdown.svelte';
	import type { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import {
		isActivePullRequestReviewRun,
		type PullRequestReviewRun,
	} from '$shared/pull-request-reviews';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import { errorMessage } from '$lib/utils/error-message.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestReviewChip from './PullRequestReviewChip.svelte';
	import { reviewRunChip } from './pr-display';

	interface Props {
		controller: PullRequestsStore;
		currentTime: Date;
		onOpenChat: (chatId: string) => void;
	}

	let { controller, currentTime, onOpenChat }: Props = $props();

	const entry = $derived(controller.selectedEntry);
	const repository = $derived(controller.selectedRepository);
	const run = $derived(controller.shownRun);
	const head = $derived(entry?.pull.headRefOid ?? '');
	const active = $derived(
		entry?.latestRun ? isActivePullRequestReviewRun(entry.latestRun.state) : false,
	);
	const canPost = $derived(
		run &&
			(run.post.status === 'unknown' ||
				(run.post.status === 'posted' && run.post.message !== null) ||
				(run.state === 'completed' &&
					run.post.status !== 'posted' &&
					run.post.status !== 'abandoned' &&
					run.post.status !== 'too-long')),
	);
	const historyUnavailable = $derived(controller.isRunsLoading || controller.runsError !== null);
	let pending = $state<'review' | 'stop' | 'post' | null>(null);
	let actionError = $state<string | null>(null);

	async function act(kind: 'review' | 'stop' | 'post', action: () => Promise<void>): Promise<void> {
		pending = kind;
		actionError = null;
		try {
			await action();
		} catch (error) {
			actionError = errorMessage(error, m.pull_request_review_action_failed());
		} finally {
			pending = null;
		}
	}

	function shortSha(sha: string | null): string {
		return sha ? sha.slice(0, 7) : '';
	}

	function runSummary(candidate: PullRequestReviewRun): string {
		const age =
			formatRelativeTimestamp(
				candidate.finishedAt ?? candidate.startedAt ?? candidate.createdAt,
				currentTime,
			)?.label ?? '';
		const commit = shortSha(candidate.reviewedSha ?? candidate.headSha);
		return candidate.reviewedSha === head || (!candidate.reviewedSha && candidate.headSha === head)
			? m.pull_request_review_run_summary_head({ commit, age })
			: m.pull_request_review_run_summary({ commit, age });
	}
</script>

<div class="min-h-0 flex-1 overflow-y-auto" data-pr-review-tab>
	{#if !entry || !repository}
		<p class="px-4 py-8 text-center text-sm text-muted-foreground">{m.pull_requests_select()}</p>
	{:else}
		<div class="flex flex-col gap-3 px-4 py-3">
			<div class="flex flex-wrap items-center gap-2">
				{#if run}
					{@const chip = reviewRunChip(run)}
					{#if chip}<PullRequestReviewChip {chip} />{/if}
					<span class="text-xs text-muted-foreground">{runSummary(run)}</span>
				{:else if !historyUnavailable}
					<span class="text-sm text-muted-foreground">{m.pull_request_review_none()}</span>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				{#if run?.chatId && run.chatAvailable}
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => onOpenChat(run.chatId!)}
					>
						<MessageSquare class="h-3.5 w-3.5" />
						{m.pull_request_review_open_chat()}
					</button>
				{/if}
				{#if canPost && run}
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
						disabled={pending !== null ||
							historyUnavailable ||
							controller.isRunLoading ||
							controller.runError !== null}
						onclick={() => act('post', () => controller.reviews.post(run.id))}
					>
						<Send class="h-3.5 w-3.5" />
						{pending === 'post'
							? m.pull_request_review_posting()
							: run.post.status === 'posted'
								? m.pull_request_review_retry_cleanup()
								: m.pull_request_review_post()}
					</button>
				{/if}
				{#if active && entry.latestRun}
					{@const latest = entry.latestRun}
					<button
						type="button"
						class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
						disabled={pending !== null}
						onclick={() => act('stop', () => controller.reviews.stop(latest.id))}
					>
						<Square class="h-3.5 w-3.5" />
						{m.pull_request_review_stop()}
					</button>
				{:else}
					<button
						type="button"
						class={cn(
							'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60',
							run
								? 'border border-border text-foreground hover:bg-accent'
								: 'bg-primary text-primary-foreground hover:bg-primary/90',
						)}
						disabled={pending !== null || historyUnavailable}
						onclick={() =>
							act('review', () => controller.reviews.review(entry.repositoryId, entry.pull.number))}
						data-pr-review-start
					>
						<RotateCw class="h-3.5 w-3.5" />
						{run ? m.pull_request_review_rerun() : m.pull_request_review_start()}
					</button>
				{/if}
			</div>
			{#if controller.isRunsLoading}
				<p class="text-xs text-muted-foreground" role="status" data-pr-review-loading>
					{m.pull_request_review_history_loading()}
				</p>
			{:else if controller.runsError}
				<div class="flex flex-wrap items-center gap-2" data-pr-review-history-error>
					<p class="text-xs text-status-error-foreground" role="alert">{controller.runsError}</p>
					<button
						type="button"
						class="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => void controller.loadRuns()}>{m.common_retry()}</button
					>
				</div>
			{/if}
			{#if controller.runError}
				<div class="flex flex-wrap items-center gap-2" role="alert">
					<p class="text-xs text-status-error-foreground">{controller.runError}</p>
					<button
						type="button"
						class="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent"
						onclick={() => void controller.loadRun()}>{m.common_retry()}</button
					>
				</div>
			{:else if controller.isRunLoading && !controller.isRunsLoading}
				<p class="text-xs text-muted-foreground" role="status">{m.common_loading()}</p>
			{/if}
			{#if canPost && repository.viewerLogin}
				<p class="text-xs text-muted-foreground">
					{m.pull_request_review_posts_as({ login: `@${repository.viewerLogin}` })}
				</p>
			{/if}
			{#if actionError}
				<p class="text-xs text-status-error-foreground" role="alert">{actionError}</p>
			{/if}
			{#if run?.state === 'needs-input'}
				<p
					class="rounded-md border border-status-warning-border bg-status-warning px-3 py-2 text-xs text-status-warning-foreground"
				>
					{run.message ?? m.pull_request_review_needs_input()}
				</p>
			{:else if run?.message && run.state !== 'completed'}
				<p class="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
					{run.message}
				</p>
			{/if}
			{#if run && run.post.status !== 'none'}
				<p class="text-xs text-muted-foreground" data-pr-post-status={run.post.status}>
					{#if run.post.status === 'posted' && run.post.commentUrl}
						<a
							class="inline-flex items-center gap-1 hover:text-foreground"
							href={run.post.commentUrl}
							target="_blank"
							rel="noreferrer noopener"
							><ExternalLink class="h-3 w-3" />{m.pull_request_review_posted_link()}</a
						>
					{:else if run.post.status === 'posted'}
						{m.pull_request_review_state_posted()}
					{:else}
						{run.post.message}
					{/if}
					{#if run.post.status === 'posted' && run.post.message}<span class="block"
							>{run.post.message}</span
						>{/if}
				</p>
			{/if}
			{#if run?.review}
				<Markdown source={run.review} class="markdown-body prose prose-sm max-w-none text-sm" />
			{/if}
			{#if controller.runs.length > 1 || controller.nextRunsCursor}
				<section class="border-t border-border pt-3">
					<h3 class="mb-1 text-xs font-medium text-muted-foreground">
						{m.pull_request_review_history()}
					</h3>
					<ul class="flex flex-col">
						{#each controller.runs as candidate (candidate.id)}
							{@const chip = reviewRunChip(candidate)}
							<li>
								<button
									type="button"
									class={cn(
										'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
										candidate.id === run?.id && 'bg-accent',
									)}
									aria-current={candidate.id === run?.id}
									data-pr-review-run={candidate.id}
									onclick={() => controller.selectRun(candidate.id)}
								>
									<span class="min-w-0 flex-1 truncate text-muted-foreground"
										>{runSummary(candidate)}</span
									>
									{#if chip}<PullRequestReviewChip {chip} />{/if}
								</button>
							</li>
						{/each}
					</ul>
					{#if controller.nextRunsCursor}
						<button
							type="button"
							class="mt-2 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-60"
							disabled={controller.isRunsLoading || controller.isMoreRunsLoading}
							onclick={() => void controller.loadMoreRuns()}
							>{controller.isMoreRunsLoading
								? m.common_loading()
								: m.pull_request_review_load_more()}</button
						>
					{/if}
				</section>
			{/if}
		</div>
	{/if}
</div>
