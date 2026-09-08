<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import {
		isChatTagRefreshRequired,
		type ChatTagReconciliationKind,
	} from '$lib/chat/sessions/chat-sessions-contract.js';

	let {
		reconciliationKind,
		baselineOutdated,
		reconciling,
		reconciliationError,
		onRetry,
		onReviewLatest,
	}: {
		reconciliationKind: ChatTagReconciliationKind;
		baselineOutdated: boolean;
		reconciling: boolean;
		reconciliationError: string | null;
		onRetry: () => void;
		onReviewLatest: () => void;
	} = $props();

	let reconciliationMessage = $derived.by(() => {
		switch (reconciliationKind) {
			case 'committed-refresh':
				return m.chat_tags_refresh_required();
			case 'conflict-refresh':
				return m.chat_tags_conflict_refresh_required();
			case 'durability':
			case null:
				return m.chat_tags_confirmation_unknown();
		}
	});
	let refreshRequired = $derived(isChatTagRefreshRequired(reconciliationKind));
	let retryLabel = $derived(
		refreshRequired ? m.chat_tags_retry_refresh() : m.chat_tags_retry_confirmation(),
	);
	let reconcilingLabel = $derived(
		refreshRequired ? m.chat_board_refreshing_tags() : m.chat_board_confirming_tags(),
	);
</script>

{#if reconciliationKind}
	<div
		class="rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
		role="alert"
	>
		<p>{reconciliationMessage}</p>
		{#if reconciliationError}<p class="mt-1">{reconciliationError}</p>{/if}
		<Button class="mt-3" variant="outline" disabled={reconciling} onclick={onRetry}>
			{reconciling ? reconcilingLabel : retryLabel}
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
