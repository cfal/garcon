<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { PullRequestReviewRun } from '$shared/pull-request-reviews';
	import { formatRelativeTimestamp } from '$lib/utils/relative-timestamp';
	import { errorMessage } from '$lib/utils/error-message.js';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestReviewChip from './PullRequestReviewChip.svelte';
	import { reviewRunChip } from './pr-display';

	interface Props {
		run: PullRequestReviewRun;
		repositoryName: string;
		currentTime: Date;
		onOpenChat: (chatId: string) => void;
		onPost: (runId: string) => Promise<void>;
	}

	let { run, repositoryName, currentTime, onOpenChat, onPost }: Props = $props();
	const chip = $derived(reviewRunChip(run));
	const age = $derived(formatRelativeTimestamp(run.createdAt, currentTime));
	const canRecover = $derived(
		run.post.status === 'unknown' || (run.post.status === 'posted' && run.post.message !== null),
	);
	let pending = $state(false);
	let actionError = $state<string | null>(null);

	async function recoverPost(): Promise<void> {
		if (pending) return;
		pending = true;
		actionError = null;
		try {
			await onPost(run.id);
		} catch (error) {
			actionError = errorMessage(error, m.pull_request_review_action_failed());
		} finally {
			pending = false;
		}
	}
</script>

<li class="min-w-0 space-y-1 px-3 py-2 text-xs" data-pr-recent-run={run.id}>
	<div class="flex min-w-0 flex-wrap items-center gap-2">
		{#if chip}<PullRequestReviewChip {chip} />{/if}
		<span
			class="min-w-0 flex-1 truncate text-foreground max-sm:order-first max-sm:basis-full max-sm:flex-none"
			title={`${repositoryName} #${run.number} · ${run.title}`}
		>
			{repositoryName} #{run.number} · {run.title}
		</span>
		{#if age}<time class="shrink-0 text-muted-foreground" datetime={run.createdAt}>{age.label}</time
			>{/if}
		{#if canRecover}
			<Button
				size="sm"
				variant="secondary"
				disabled={pending}
				onclick={() => void recoverPost()}
				data-pr-reconcile-run={run.post.status === 'unknown' ? run.id : undefined}
				data-pr-retry-cleanup-run={run.post.status === 'posted' ? run.id : undefined}
			>
				{pending
					? m.pull_request_inbox_checking()
					: run.post.status === 'unknown'
						? m.pull_request_review_reconcile_post()
						: m.pull_request_review_retry_cleanup()}
			</Button>
		{/if}
		{#if run.chatId && run.chatAvailable}
			<Button size="sm" variant="ghost" onclick={() => run.chatId && onOpenChat(run.chatId)}>
				{m.pull_request_review_open_chat()}
			</Button>
		{/if}
	</div>
	{#if run.message && run.state !== 'completed'}
		<p class="break-words text-muted-foreground">{run.message}</p>
	{/if}
	{#if run.post.status !== 'none'}
		<p class="break-words text-muted-foreground" data-pr-post-status={run.post.status}>
			{#if run.post.status === 'posted'}
				{#if run.post.commentUrl}
					<a
						href={run.post.commentUrl}
						target="_blank"
						rel="noreferrer noopener"
						class="underline hover:text-foreground">{m.pull_request_review_posted_link()}</a
					>
				{:else}
					{m.pull_request_review_state_posted()}
				{/if}
			{/if}
			{#if run.post.message}<span class="block">{run.post.message}</span>{/if}
		</p>
	{/if}
	{#if actionError}
		<p class="break-words text-status-error-foreground" role="alert">{actionError}</p>
	{/if}
</li>
