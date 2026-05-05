<!-- Server-stored settings. Shows a loading state until remote settings
     are available; never renders guessed defaults. -->
<script lang="ts">
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import SendIcon from '@lucide/svelte/icons/send';
	import { getRemoteSettings, getModelCatalog } from '$lib/context';
	import { sendTelegramTest } from '$lib/api/settings.js';
	import type { SessionProvider } from '$lib/types/app';
	import type { PinnedInsertPosition } from '$lib/types/session.js';
	import * as m from '$lib/paraglide/messages.js';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import type { ModelSelectorChange, ModelSelectorMode } from '$lib/components/model-selector/model-selector-types';

	const remoteSettings = getRemoteSettings();
	const modelCatalog = getModelCatalog();

	let saveError = $state<string | null>(null);

	// Chat title generation local editing state (hydrated from snapshot).
	let titleEnabled = $derived(
		remoteSettings.snapshot?.uiEffective?.chatTitle?.enabled !== false
	);
	let titleProvider = $derived<SessionProvider>(
		(remoteSettings.snapshot?.uiEffective?.chatTitle?.provider as SessionProvider) ?? 'claude'
	);
	let titleModel = $derived(
		remoteSettings.snapshot?.uiEffective?.chatTitle?.model ?? ''
	);
	let titleModelEndpointId = $derived(
		remoteSettings.snapshot?.uiEffective?.chatTitle?.modelEndpointId ?? null
	);
	const titleSelectorMode: ModelSelectorMode = { harness: 'select', source: 'select', surface: 'settings' };
	const titleSelectorValue = $derived({
		harnessId: titleProvider,
		model: titleModel,
		modelEndpointId: titleModelEndpointId,
	});

	// Telegram state derived from snapshot.
	let telegramBotAvailable = $derived(
		remoteSettings.snapshot?.telegramBotTokenAvailable === true
	);
	let telegramEnabled = $derived(
		remoteSettings.snapshot?.ui?.notifications?.telegram?.enabled === true
	);
	let telegramChatId = $state('');
	let telegramDraftVersion = $state<number | null>(null);
	let isTelegramChatIdDirty = $state(false);
	let isTelegramChatIdFocused = $state(false);

	// Rehydrates the telegram draft from remote settings unless the user is
	// actively editing an unsaved value.
	$effect(() => {
		const snap = remoteSettings.snapshot;
		if (!snap) return;
		if (telegramDraftVersion === snap.version) return;
		telegramDraftVersion = snap.version;
		if (isTelegramChatIdFocused && isTelegramChatIdDirty) return;
		const remote = snap.ui?.notifications?.telegram?.chatId ?? '';
		telegramChatId = remote;
		isTelegramChatIdDirty = false;
	});

	let telegramTestSending = $state(false);
	let telegramTestResult = $state<{ ok: boolean; message: string } | null>(null);

	async function save(patch: Record<string, unknown>) {
		saveError = null;
		try {
			await remoteSettings.update({ ui: patch });
		} catch (error) {
			saveError = error instanceof Error ? error.message : 'Failed to save setting';
		}
	}

	async function onPinnedInsertPositionChange(next: PinnedInsertPosition) {
		await save({ pinnedInsertPosition: next });
	}

	async function persistChatTitleSettings(overrides?: Record<string, unknown>) {
		const base = remoteSettings.snapshot?.ui?.chatTitle ?? {};
		const nextProvider = typeof overrides?.provider === 'string'
			? overrides.provider as SessionProvider
			: titleProvider;
		const nextModelInput = typeof overrides?.model === 'string'
			? overrides.model
			: modelCatalog.selectionValueFor(nextProvider, titleModel, titleModelEndpointId);
		const selection = modelCatalog.selectionFor(nextProvider, nextModelInput, titleModelEndpointId);
		await save({
			chatTitle: {
				...base,
				enabled: titleEnabled,
				...overrides,
				provider: nextProvider,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			},
		});
	}

	async function persistChatTitleSelection(next: ModelSelectorChange) {
		const base = remoteSettings.snapshot?.ui?.chatTitle ?? {};
		await save({
			chatTitle: {
				...base,
				enabled: titleEnabled,
				provider: next.harnessId,
				model: next.model,
				apiProviderId: next.apiProviderId,
				modelEndpointId: next.modelEndpointId,
				modelProtocol: next.modelProtocol,
			},
		});
	}

	async function persistTelegramSettings(overrides?: { enabled?: boolean }) {
		await save({
			notifications: {
				telegram: {
					enabled: overrides?.enabled ?? telegramEnabled,
					chatId: telegramChatId,
				},
			},
		});
	}

	async function handleTelegramTest() {
		if (!telegramChatId.trim()) return;
		telegramTestSending = true;
		telegramTestResult = null;
		try {
			const res = await sendTelegramTest(telegramChatId.trim());
			telegramTestResult = res.success
				? { ok: true, message: 'Test message sent.' }
				: { ok: false, message: res.error ?? 'Send failed.' };
		} catch {
			telegramTestResult = { ok: false, message: 'Request failed.' };
		} finally {
			telegramTestSending = false;
		}
	}
</script>

<div class="space-y-3">
	{#if !remoteSettings.hasSnapshot}
		<div class="py-12 flex items-center justify-center text-muted-foreground">
			{m.status_loading()}
		</div>
	{:else}
		{#if saveError}
			<div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
				{saveError}
			</div>
		{/if}

		<div class="bg-muted/50 border border-border rounded-lg">
			<div class="flex items-center justify-between px-4 py-2">
				<div class="text-sm font-medium text-foreground">{m.sidebar_chats_pinned_insert_position()}</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					aria-label={m.sidebar_chats_pinned_insert_position()}
					value={remoteSettings.snapshot?.ui.pinnedInsertPosition ?? 'top'}
					onchange={(e) =>
						onPinnedInsertPositionChange((e.currentTarget as HTMLSelectElement).value as PinnedInsertPosition)}
				>
					<option value="top">{m.sidebar_chats_pinned_insert_top()}</option>
					<option value="bottom">{m.sidebar_chats_pinned_insert_bottom()}</option>
				</select>
			</div>
		</div>

		<!-- Chat title generation -->
		<div class="bg-muted/50 border border-border rounded-lg px-4">
			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_generate_titles()}</div>
				<Switch
					checked={titleEnabled}
					onCheckedChange={async (next) => {
						await persistChatTitleSettings({ enabled: Boolean(next) });
					}}
					aria-label={m.settings_chat_generate_titles()}
				/>
			</div>

				{#if titleEnabled}
					<div class="flex items-center justify-between py-2">
						<div class="text-sm font-medium text-foreground">{m.settings_chat_title_model()}</div>
						<SettingsModelSelector
							value={titleSelectorValue}
							mode={titleSelectorMode}
							onChange={persistChatTitleSelection}
							align="end"
							side="bottom"
						/>
					</div>
				{/if}
		</div>

		<!-- Telegram Notifications -->
		<div class="bg-muted/50 border border-border rounded-lg px-4">
			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">Telegram notifications</div>
				<Switch
					checked={telegramEnabled}
					disabled={!telegramBotAvailable}
					onCheckedChange={async (next) => {
						await persistTelegramSettings({ enabled: Boolean(next) });
					}}
					aria-label="Telegram notifications"
				/>
			</div>

			{#if !telegramBotAvailable}
				<p class="text-xs text-muted-foreground pb-2">
					Set <code class="text-xs bg-muted px-1 py-0.5 rounded">GARCON_TELEGRAM_BOT_TOKEN</code> to enable.
				</p>
			{/if}

			{#if telegramBotAvailable && telegramEnabled}
				<div class="flex items-center justify-between py-2 gap-3">
					<div class="text-sm font-medium text-foreground shrink-0">Chat ID</div>
						<input
							type="text"
							class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground w-40"
							placeholder="123456789"
							value={telegramChatId}
							onfocus={() => { isTelegramChatIdFocused = true; }}
							oninput={(e) => {
								telegramChatId = (e.currentTarget as HTMLInputElement).value;
								isTelegramChatIdDirty = true;
							}}
							onblur={async () => {
								isTelegramChatIdFocused = false;
								await persistTelegramSettings();
							}}
						/>
					</div>

				<div class="flex items-center justify-between py-2 pb-3">
					<div class="flex items-center gap-2">
						{#if telegramTestResult}
							<span class="text-xs {telegramTestResult.ok ? 'text-accent-foreground' : 'text-destructive'}">
								{telegramTestResult.message}
							</span>
						{/if}
					</div>
					<Button
						variant="outline"
						size="sm"
						disabled={telegramTestSending || !telegramChatId.trim()}
						onclick={handleTelegramTest}
					>
						<SendIcon class="size-3.5 mr-1.5" />
						{telegramTestSending ? 'Sending...' : 'Send test'}
					</Button>
				</div>
			{/if}
		</div>
	{/if}
</div>
