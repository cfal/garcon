<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import * as m from '$lib/paraglide/messages.js';
	import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

	let { status }: { status: ChatSessionRecord['activityStatus'] } = $props();
	let label = $derived(
		status === 'working'
			? m.chat_window_processing()
			: status === 'complete'
				? m.sidebar_chat_status_complete()
				: status === 'error'
					? m.sidebar_chat_status_error()
					: status === 'pending-user-action'
						? m.sidebar_chat_status_pending_user_action()
						: undefined,
	);
</script>

<span
	class="inline-flex size-4 shrink-0 items-center justify-center"
	data-slot="sidebar-chat-status"
	data-status={status ?? undefined}
	title={label}
	aria-hidden={status ? undefined : true}
>
	{#if label}
		<span class="sr-only">{label}</span>
	{/if}
	{#if status === 'working'}
		<span
			class="sidebar-chat-status-spinner inline-flex size-3 text-status-processing-foreground"
			data-slot="sidebar-chat-processing-indicator"
			aria-hidden="true"
		>
			<LoaderCircle class="size-3" />
		</span>
	{:else if status === 'complete' || status === 'error'}
		<span
			class={status === 'complete'
				? 'size-2 rounded-full bg-sidebar-chat-complete'
				: 'size-2 rounded-full bg-sidebar-chat-error'}
			aria-hidden="true"
		></span>
	{:else if status === 'pending-user-action'}
		<CircleAlert class="size-3.5 text-status-warning" aria-hidden="true" />
	{/if}
</span>

<style>
	@keyframes sidebar-status-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.sidebar-chat-status-spinner {
			animation: sidebar-status-spin 1s linear infinite;
		}

		:global(.sidebar-reduce-motion) .sidebar-chat-status-spinner {
			animation: none;
		}
	}
</style>
