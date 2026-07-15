<script lang="ts">
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Info from '@lucide/svelte/icons/info';
	import X from '@lucide/svelte/icons/x';
	import type { AppNotification, NotificationsStore } from '$lib/stores/notifications.svelte';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	interface NotificationHostProps {
		notifications: NotificationsStore;
		desktopLeftPx?: number;
	}

	let { notifications, desktopLeftPx = 16 }: NotificationHostProps = $props();

	const visibleNotifications = $derived(notifications.items);
	const notificationStyle = $derived(`--notification-left-desktop: ${desktopLeftPx}px`);

	$effect(() => {
		const timeoutIds = visibleNotifications
			.filter((notification) => notification.expiresAt !== null)
			.map((notification) => {
				const remainingMs = Math.max(0, notification.expiresAt! - Date.now());
				return window.setTimeout(() => notifications.dismiss(notification.id), remainingMs);
			});

		return () => {
			for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId);
		};
	});

	function getNotificationClasses(notification: AppNotification): string {
		return cn(
			'pointer-events-auto flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 shadow-lg backdrop-blur-sm',
			notification.tone === 'error'
				? 'border-status-error-border bg-status-error text-status-error-foreground'
				: 'border-status-info-border bg-status-info text-status-info-foreground',
		);
	}

	function getDismissClasses(notification: AppNotification): string {
		return cn(
			'inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
			notification.tone === 'error'
				? 'hover:bg-status-error-foreground/10'
				: 'hover:bg-status-info-foreground/10',
		);
	}
</script>

{#if visibleNotifications.length > 0}
	<section
		class="fixed inset-x-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[100] flex flex-col gap-2 sm:inset-x-auto sm:left-[var(--notification-left-desktop)] sm:right-auto sm:w-96"
		style={notificationStyle}
		aria-label={m.notifications_region()}
		aria-live="polite"
	>
		{#each visibleNotifications as notification (notification.id)}
			<div
				class={getNotificationClasses(notification)}
				role={notification.tone === 'error' ? 'alert' : 'status'}
			>
				{#if notification.tone === 'error'}
					<CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{:else}
					<Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
				{/if}

				<p class="min-w-0 flex-1 text-sm leading-5">{notification.message}</p>
				{#if notification.action}
					<button
						type="button"
						class="shrink-0 rounded-md border border-current/30 px-2 py-1 text-xs font-medium hover:bg-current/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
						onclick={() => {
							const completed = notification.action?.onClick();
							if (completed !== false) notifications.dismiss(notification.id);
						}}
					>
						{notification.action.label}
					</button>
				{/if}

				<button
					type="button"
					class={getDismissClasses(notification)}
					aria-label={m.notifications_dismiss()}
					onclick={() => notifications.dismiss(notification.id)}
				>
					<X class="size-3.5" aria-hidden="true" />
				</button>
			</div>
		{/each}
	</section>
{/if}
