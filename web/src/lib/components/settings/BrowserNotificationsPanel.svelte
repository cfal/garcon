<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { getBrowserNotifications, getRemoteSettings } from '$lib/context';
	import type { BrowserNotificationPreviewMode } from '$shared/settings';
	import BellIcon from '@lucide/svelte/icons/bell';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import SendIcon from '@lucide/svelte/icons/send';
	import * as m from '$lib/paraglide/messages.js';

	const browserNotifications = getBrowserNotifications();
	const remoteSettings = getRemoteSettings();

	let browserSettings = $derived(remoteSettings.snapshot?.ui.notifications?.browser);
	let serverStatus = $derived(remoteSettings.snapshot?.browserNotifications);
	let browserEnabled = $derived(browserSettings?.enabled === true);
	let previewMode = $derived<BrowserNotificationPreviewMode>(
		browserSettings?.previewMode === 'message-preview' ? 'message-preview' : 'status-only',
	);
	let serverKeyAvailable = $derived(serverStatus?.vapidPublicKeyAvailable === true);
	let subscriptionCount = $derived(serverStatus?.subscriptionCount ?? 0);
	let canEnable = $derived(
		browserNotifications.support.supported &&
			browserNotifications.permission !== 'denied' &&
			!browserNotifications.isBusy,
	);
	let isActive = $derived(
		browserEnabled &&
			browserNotifications.isPermissionGranted &&
			browserNotifications.isSubscribed,
	);
	let supportMessage = $derived.by(() => {
		if (browserNotifications.permission === 'denied') {
			return m.settings_browser_permission_denied();
		}
		switch (browserNotifications.support.reason) {
			case 'unsupported-server':
				return m.settings_browser_unsupported_server();
			case 'insecure-context':
				return m.settings_browser_unsupported_https();
			case 'missing-notification-api':
			case 'missing-service-worker':
			case 'ios-not-installed':
			case 'missing-push-manager':
				return m.settings_browser_unsupported_home_screen();
			case 'supported':
				return isActive
					? m.settings_browser_enabled_status({ count: subscriptionCount })
					: m.settings_browser_ready();
			case 'checking':
			default:
				return m.status_loading();
		}
	});

	async function persistPreviewMode(next: BrowserNotificationPreviewMode) {
		await remoteSettings.update({
			ui: {
				notifications: {
					browser: {
						previewMode: next,
					},
				},
			},
		});
	}

	async function handleToggle(next: boolean) {
		if (next) {
			await browserNotifications.enable(serverKeyAvailable);
			return;
		}
		await browserNotifications.disable();
	}

	async function handleTest() {
		await browserNotifications.sendTest();
	}
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4">
	<div class="flex items-center justify-between py-2 gap-3">
		<div class="min-w-0">
			<div class="text-sm font-medium text-foreground">{m.settings_browser_notifications()}</div>
			<div class="text-xs text-muted-foreground">{supportMessage}</div>
		</div>
		<Switch
			checked={isActive}
			disabled={!canEnable && !isActive}
			onCheckedChange={(next) => {
				void handleToggle(Boolean(next));
			}}
			aria-label={m.settings_browser_notifications()}
		/>
	</div>

	<div class="flex flex-col gap-3 py-2">
		<div class="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
			<label class="text-sm font-medium text-foreground" for="browser-notification-preview">
				{m.settings_browser_preview_mode()}
			</label>
			<select
				id="browser-notification-preview"
				class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
				value={previewMode}
				onchange={(event) => {
					void persistPreviewMode(
						(event.currentTarget as HTMLSelectElement).value as BrowserNotificationPreviewMode,
					);
				}}
			>
				<option value="status-only">{m.settings_browser_preview_status_only()}</option>
				<option value="message-preview">{m.settings_browser_preview_message_preview()}</option>
			</select>
		</div>

		<div class="flex flex-wrap gap-2">
			{#if isActive}
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={browserNotifications.isBusy}
					onclick={handleTest}
				>
					<SendIcon class="size-3.5 mr-1.5" />
					{browserNotifications.isBusy ? m.settings_browser_sending() : m.settings_browser_send_test()}
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={browserNotifications.isBusy}
					onclick={() => {
						void browserNotifications.disable();
					}}
				>
					<BellOffIcon class="size-3.5 mr-1.5" />
					{m.settings_browser_disable()}
				</Button>
			{:else}
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!canEnable}
					onclick={() => {
						void browserNotifications.enable(serverKeyAvailable);
					}}
				>
					<BellIcon class="size-3.5 mr-1.5" />
					{browserNotifications.isBusy
						? m.settings_browser_enabling()
						: m.settings_browser_enable()}
				</Button>
			{/if}
		</div>

		{#if browserNotifications.lastError}
			<span class="text-xs text-destructive">
				{browserNotifications.lastError}
			</span>
		{/if}
		{#if browserNotifications.lastTestResult}
			<span
				class="text-xs {browserNotifications.lastTestResult.ok
					? 'text-accent-foreground'
					: 'text-destructive'}"
			>
				{browserNotifications.lastTestResult.ok
					? m.settings_browser_test_sent()
					: m.settings_browser_test_failed()}
			</span>
		{/if}
	</div>
</div>
