<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatTagConfirmationKind } from '$lib/chat/sessions/chat-sessions-contract.js';

	let {
		confirmationKind,
		baselineOutdated,
		confirming,
		confirmationError,
		onRetry,
		onReviewLatest,
	}: {
		confirmationKind: ChatTagConfirmationKind;
		baselineOutdated: boolean;
		confirming: boolean;
		confirmationError: string | null;
		onRetry: () => void;
		onReviewLatest: () => void;
	} = $props();

	let confirmationMessage = $derived(
		confirmationKind === 'reconciliation'
			? m.chat_tags_refresh_required()
			: m.chat_tags_confirmation_unknown(),
	);
	let retryLabel = $derived(
		confirmationKind === 'reconciliation'
			? m.chat_tags_retry_refresh()
			: m.chat_tags_retry_confirmation(),
	);
	let confirmingLabel = $derived(
		confirmationKind === 'reconciliation'
			? m.chat_board_refreshing_tags()
			: m.chat_board_confirming_tags(),
	);
</script>

{#if confirmationKind}
	<div
		class="rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
		role="alert"
	>
		<p>{confirmationMessage}</p>
		{#if confirmationError}<p class="mt-1">{confirmationError}</p>{/if}
		<Button class="mt-3" variant="outline" disabled={confirming} onclick={onRetry}>
			{confirming ? confirmingLabel : retryLabel}
		</Button>
	</div>
{:else if baselineOutdated}
	<div
		class="rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
		role="alert"
	>
		<p>{m.chat_tags_outdated()}</p>
		<Button class="mt-3" variant="outline" onclick={onReviewLatest}>
			{m.chat_tags_review_latest()}
		</Button>
	</div>
{/if}
