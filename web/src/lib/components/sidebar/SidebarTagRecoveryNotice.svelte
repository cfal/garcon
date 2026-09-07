<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	let {
		recoveryRequired,
		baselineOutdated,
		recovering,
		recoveryError,
		onRetry,
		onReviewLatest,
	}: {
		recoveryRequired: boolean;
		baselineOutdated: boolean;
		recovering: boolean;
		recoveryError: string | null;
		onRetry: () => void;
		onReviewLatest: () => void;
	} = $props();
</script>

{#if recoveryRequired}
	<div
		class="rounded-lg border border-status-warning-border bg-status-warning/10 p-3 text-sm text-status-warning-muted-foreground"
		role="alert"
	>
		<p>{m.chat_tags_confirmation_unknown()}</p>
		{#if recoveryError}<p class="mt-1">{recoveryError}</p>{/if}
		<Button class="mt-3" variant="outline" disabled={recovering} onclick={onRetry}>
			{recovering ? m.chat_board_confirming_tags() : m.chat_tags_retry_confirmation()}
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
