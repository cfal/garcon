<script lang="ts">
	import { onMount } from 'svelte';
	import { getLocalSettings } from '$lib/context';
	import { Button } from '$lib/components/ui/button';
	import {
		browserNotificationPermission,
		requestBrowserNotificationPermission,
		type BrowserNotificationPermission,
	} from '$lib/notifications/browser-notifications.js';
	import * as m from '$lib/paraglide/messages.js';

	const localSettings = getLocalSettings();
	let permission = $state<BrowserNotificationPermission>('unsupported');
	let requesting = $state(false);
	const descriptions = {
		default: m.browser_notifications_default,
		granted: m.browser_notifications_granted,
		denied: m.browser_notifications_denied,
		unsupported: m.browser_notifications_unsupported,
	};
	onMount(() => {
		const refresh = () => {
			permission = browserNotificationPermission();
		};
		refresh();
		window.addEventListener('focus', refresh);
		return () => window.removeEventListener('focus', refresh);
	});

	async function enable(): Promise<void> {
		if (requesting) return;
		requesting = true;
		permission = await requestBrowserNotificationPermission();
		if (permission === 'granted') localSettings.set('browserNotifications', true);
		requesting = false;
	}
</script>

<section
	class="rounded-lg border border-border bg-card p-4 space-y-3"
	aria-label={m.browser_notifications_title()}
>
	<div>
		<h3 class="text-sm font-semibold text-foreground">{m.browser_notifications_title()}</h3>
		<p class="mt-1 text-sm text-muted-foreground">{m.browser_notifications_description()}</p>
	</div>
	<label class="flex items-center gap-3 text-sm text-foreground">
		<input
			type="checkbox"
			class="size-4 accent-primary"
			checked={localSettings.browserNotifications}
			disabled={permission !== 'granted'}
			onchange={(event) => localSettings.set('browserNotifications', event.currentTarget.checked)}
		/>
		{m.browser_notifications_toggle()}
	</label>
	<p class="text-xs text-muted-foreground" role="status">{descriptions[permission]()}</p>
	{#if permission === 'default'}
		<Button disabled={requesting} onclick={() => void enable()}
			>{m.browser_notifications_enable()}</Button
		>
	{/if}
</section>
