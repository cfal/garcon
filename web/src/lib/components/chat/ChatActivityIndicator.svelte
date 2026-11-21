<script module lang="ts">
	import type { ChatActivityStatus } from '$shared/chat-activity';
	import * as m from '$lib/paraglide/messages.js';

	export type ChatIndicatorStatus = Exclude<ChatActivityStatus, 'complete'>;
	const statusLabels: Record<ChatIndicatorStatus, () => string> = {
		working: m.chat_window_processing,
		'pending-user-action': m.sidebar_chat_status_pending_user_action,
		error: m.sidebar_chat_status_error,
	};
</script>

<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { attachProcessingPulse } from '$lib/chat/sessions/processing-pulse';

	let {
		status,
		descriptionId,
		spinnerSizePx = 12,
	}: {
		status: ChatIndicatorStatus;
		descriptionId?: string;
		spinnerSizePx?: number;
	} = $props();

	let label = $derived(statusLabels[status]());
</script>

<span
	class="inline-flex shrink-0 items-center"
	data-slot="chat-activity-indicator"
	data-status={status}
	title={descriptionId ? undefined : label}
>
	<span class="sr-only" id={descriptionId}>{label}</span>
	{#if status === 'working'}
		<span
			class="chat-processing-spinner inline-flex text-status-processing-foreground"
			style:width={`${spinnerSizePx}px`}
			style:height={`${spinnerSizePx}px`}
			aria-hidden="true"
			{@attach attachProcessingPulse}
		>
			<!-- The size utility opts out of the row button's default SVG dimensions. -->
			<LoaderCircle class="size-full" />
		</span>
	{:else if status === 'error'}
		<span class="size-2 rounded-full bg-sidebar-chat-error" aria-hidden="true"></span>
	{:else}
		<CircleAlert class="size-3.5 text-status-warning" aria-hidden="true" />
	{/if}
</span>
