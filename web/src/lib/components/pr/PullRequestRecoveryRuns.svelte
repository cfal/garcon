<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { PullRequestRecoveryState } from '$lib/git/pull-requests/pull-request-recovery-state.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import PullRequestRecentRunRow from './PullRequestRecentRunRow.svelte';

	interface Props {
		currentTime: Date;
		repositoryName: (repositoryId: string) => string;
		onOpenChat: (chatId: string) => void;
		onPost: (runId: string) => Promise<void>;
		onAbandon: (runId: string) => Promise<void>;
	}
	let { currentTime, repositoryName, onOpenChat, onPost, onAbandon }: Props = $props();
	const recovery = new PullRequestRecoveryState();
	onMount(() => {
		void recovery.load();
		return () => recovery.dispose();
	});

	async function reconcile(runId: string): Promise<void> {
		await onPost(runId);
		await recovery.load();
	}
</script>

<div class="space-y-2" data-pr-post-recovery>
	<div class="flex items-center justify-between gap-2">
		<p class="text-xs text-muted-foreground">{m.pull_request_review_recovery_hint()}</p>
		<Button size="sm" variant="ghost" disabled={recovery.isLoading} onclick={() => recovery.load()}
			>{m.common_refresh()}</Button
		>
	</div>
	{#if recovery.error}
		<p class="text-xs text-status-error-foreground" role="alert">{recovery.error}</p>
	{:else if recovery.runs.length === 0 && !recovery.isLoading}
		<p class="text-sm text-muted-foreground">{m.pull_request_review_recovery_empty()}</p>
	{/if}
	<ol class="divide-y divide-border rounded-md border border-border">
		{#each recovery.runs as entry (entry.id)}
			<PullRequestRecentRunRow
				run={entry}
				repositoryName={repositoryName(entry.repositoryId)}
				{currentTime}
				{onOpenChat}
				onPost={reconcile}
				onAbandon={async (runId) => {
					await onAbandon(runId);
					await recovery.load();
				}}
			/>
		{/each}
	</ol>
	{#if recovery.isLoading}<p class="text-xs text-muted-foreground" role="status">
			{m.common_loading()}
		</p>{/if}
	{#if recovery.nextCursor}
		<Button
			size="sm"
			variant="outline"
			disabled={recovery.isLoading}
			onclick={() => recovery.load(recovery.nextCursor!)}
			>{m.pull_request_review_load_more()}</Button
		>
	{/if}
</div>
