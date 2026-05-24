<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import {
		beginTelegramRecipientLink,
		clearTelegramBotToken,
		clearTelegramRecipient,
		resolveTelegramRecipientLink,
		saveTelegramBotToken,
		sendTelegramTest,
		testTelegramBotToken,
	} from '$lib/api/settings.js';
	import { ApiError } from '$lib/api/client.js';
	import { getRemoteSettings } from '$lib/context';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SaveIcon from '@lucide/svelte/icons/save';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import * as m from '$lib/paraglide/messages.js';

	const remoteSettings = getRemoteSettings();

	let telegramStatus = $derived(remoteSettings.snapshot?.telegram);
	let telegramBotAvailable = $derived(telegramStatus?.botTokenAvailable === true);
	let telegramBotUsername = $derived(telegramStatus?.botUsername ?? null);
	let telegramRecipientLinked = $derived(telegramStatus?.recipientLinked === true);
	let telegramRecipientUsername = $derived(telegramStatus?.recipientUsername ?? null);
	let telegramRecipientDisplayName = $derived(telegramStatus?.recipientDisplayName ?? null);
	let telegramLinkUrl = $derived(telegramStatus?.linkUrl ?? null);
	let telegramEnabled = $derived(
		remoteSettings.snapshot?.ui?.notifications?.telegram?.enabled === true
	);
	let telegramReady = $derived(telegramBotAvailable && telegramRecipientLinked);
	let telegramNotificationsActive = $derived(telegramReady && telegramEnabled);
	let linkedRecipientLabel = $derived(
		telegramRecipientUsername
			? `@${telegramRecipientUsername}`
			: telegramRecipientDisplayName ?? (telegramRecipientLinked ? m.settings_telegram_linked_account() : '')
	);

	let telegramBotToken = $state('');
	let tokenBusy = $state(false);
	let tokenTestBusy = $state(false);
	let recipientLinkBusy = $state(false);
	let recipientResolveBusy = $state(false);
	let recipientClearBusy = $state(false);
	let testMessageBusy = $state(false);
	let autoLinkAttemptKey = $state('');
	let tokenResult = $state<{ ok: boolean; message: string } | null>(null);
	let recipientResult = $state<{ ok: boolean; message: string } | null>(null);
	let testMessageResult = $state<{ ok: boolean; message: string } | null>(null);

	$effect(() => {
		if (!telegramBotAvailable) {
			autoLinkAttemptKey = '';
			return;
		}
		if (telegramRecipientLinked || telegramLinkUrl || tokenBusy || recipientLinkBusy) return;
		const botKey = telegramBotUsername ?? 'configured';
		if (autoLinkAttemptKey === botKey) return;
		autoLinkAttemptKey = botKey;
		void ensureRecipientLink();
	});

	async function persistTelegramEnabled(enabled: boolean) {
		await remoteSettings.update({
			ui: {
				notifications: {
					telegram: { enabled },
				},
			},
		});
	}

	function errorMessage(error: unknown): string {
		if (error instanceof ApiError) {
			const message =
				error.errorCode === 'telegram_token_test_failed'
					? m.settings_telegram_error_token_test_failed()
					: error.errorCode === 'telegram_bot_token_required'
						? m.settings_telegram_error_bot_token_required()
						: error.message;
			const detail = error.details ? `: ${error.details}` : '';
			const code = error.errorCode ? ` (${error.errorCode})` : '';
			return `${message}${detail}${code}`;
		}
		return error instanceof Error ? error.message : m.settings_telegram_request_failed();
	}

	async function handleTokenSave() {
		const botToken = telegramBotToken.trim();
		if (!botToken) return;
		tokenBusy = true;
		tokenResult = null;
		recipientResult = null;
		try {
			const res = await saveTelegramBotToken(botToken);
			remoteSettings.applySnapshot(res.settings);
			telegramBotToken = '';
			tokenResult = null;
		} catch (error) {
			tokenResult = { ok: false, message: errorMessage(error) };
		} finally {
			tokenBusy = false;
		}
	}

	async function handleTokenTest() {
		if (!telegramBotAvailable) return;
		tokenTestBusy = true;
		tokenResult = null;
		try {
			const res = await testTelegramBotToken();
			tokenResult = {
				ok: true,
				message: m.settings_telegram_token_valid_for({ username: `@${res.bot.username}` }),
			};
		} catch (error) {
			tokenResult = { ok: false, message: errorMessage(error) };
		} finally {
			tokenTestBusy = false;
		}
	}

	async function handleTokenClear() {
		if (!telegramBotAvailable) return;
		tokenBusy = true;
		tokenResult = null;
		recipientResult = null;
		try {
			const res = await clearTelegramBotToken();
			remoteSettings.applySnapshot(res.settings);
			telegramBotToken = '';
			tokenResult = { ok: true, message: m.settings_telegram_token_cleared() };
		} catch (error) {
			tokenResult = { ok: false, message: errorMessage(error) };
		} finally {
			tokenBusy = false;
		}
	}

	async function ensureRecipientLink() {
		if (!telegramBotAvailable) return;
		recipientLinkBusy = true;
		recipientResult = null;
		try {
			const res = await beginTelegramRecipientLink();
			remoteSettings.applySnapshot(res.settings);
		} catch (error) {
			recipientResult = { ok: false, message: errorMessage(error) };
		} finally {
			recipientLinkBusy = false;
		}
	}

	async function handleRecipientResolve() {
		if (!telegramLinkUrl) return;
		recipientResolveBusy = true;
		recipientResult = null;
		try {
			const res = await resolveTelegramRecipientLink();
			remoteSettings.applySnapshot(res.settings);
			recipientResult = res.success
				? { ok: true, message: m.settings_telegram_recipient_linked() }
				: { ok: false, message: res.error ?? m.settings_telegram_link_not_found() };
		} catch (error) {
			recipientResult = { ok: false, message: errorMessage(error) };
		} finally {
			recipientResolveBusy = false;
		}
	}

	async function handleRecipientClear() {
		if (!telegramRecipientLinked && !telegramLinkUrl) return;
		recipientClearBusy = true;
		recipientResult = null;
		try {
			const res = await clearTelegramRecipient();
			remoteSettings.applySnapshot(res.settings);
			recipientResult = { ok: true, message: m.settings_telegram_recipient_cleared() };
		} catch (error) {
			recipientResult = { ok: false, message: errorMessage(error) };
		} finally {
			recipientClearBusy = false;
		}
	}

	async function handleTelegramTest() {
		if (!telegramReady) return;
		testMessageBusy = true;
		testMessageResult = null;
		try {
			const res = await sendTelegramTest();
			testMessageResult = res.success
				? { ok: true, message: m.settings_telegram_test_sent() }
				: { ok: false, message: res.error ?? m.settings_telegram_send_failed() };
		} catch (error) {
			testMessageResult = { ok: false, message: errorMessage(error) };
		} finally {
			testMessageBusy = false;
		}
	}
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4">
	<div class="flex items-center justify-between py-2 gap-3">
		<div class="min-w-0">
			<div class="text-sm font-medium text-foreground">{m.settings_telegram_notifications()}</div>
		</div>
		<Switch
			checked={telegramNotificationsActive}
			disabled={!telegramReady}
			onCheckedChange={async (next) => {
				await persistTelegramEnabled(Boolean(next));
			}}
			aria-label={m.settings_telegram_notifications()}
		/>
	</div>

	<div class="flex flex-col gap-2 py-2">
		<label class="text-sm font-medium text-foreground" for="telegram-bot-token">
			{m.settings_telegram_bot_token()}
		</label>
			<div class="flex flex-col gap-2 lg:flex-row">
				<Input
					id="telegram-bot-token"
					type="password"
					class="min-w-0 flex-1"
					autocomplete="off"
					placeholder={telegramBotAvailable
						? m.settings_telegram_bot_token_configured()
						: m.settings_telegram_bot_token_placeholder()}
					disabled={telegramBotAvailable || tokenBusy || tokenTestBusy}
					value={telegramBotToken}
					oninput={(e) => { telegramBotToken = (e.currentTarget as HTMLInputElement).value; }}
				/>
				<div class="flex flex-wrap gap-2">
					{#if telegramBotAvailable}
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={tokenBusy || tokenTestBusy}
							onclick={handleTokenTest}
						>
							<CheckIcon class="size-3.5 mr-1.5" />
							{tokenTestBusy ? m.settings_telegram_testing_token() : m.settings_telegram_test_token()}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={tokenBusy || tokenTestBusy}
							onclick={handleTokenClear}
						>
							<Trash2Icon class="size-3.5 mr-1.5" />
							{m.settings_telegram_clear_token()}
						</Button>
					{:else}
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={tokenBusy || tokenTestBusy || !telegramBotToken.trim()}
							onclick={handleTokenSave}
						>
							<SaveIcon class="size-3.5 mr-1.5" />
							{tokenBusy ? m.settings_telegram_saving_token() : m.settings_telegram_save_token()}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled
							onclick={handleTokenClear}
						>
							<Trash2Icon class="size-3.5 mr-1.5" />
							{m.settings_telegram_clear_token()}
						</Button>
					{/if}
				</div>
			</div>
			{#if tokenResult}
				<span class="text-xs {tokenResult.ok ? 'text-accent-foreground' : 'text-destructive'}">
					{tokenResult.message}
				</span>
			{/if}
		</div>

		{#if telegramBotAvailable}
			<div class="flex flex-col gap-2 py-2">
				<div class="min-w-0">
					{#if telegramRecipientLinked && linkedRecipientLabel}
						<div class="text-sm text-muted-foreground truncate">
							{m.settings_telegram_linked_recipient({ recipient: linkedRecipientLabel })}
						</div>
					{:else if telegramLinkUrl}
						<div class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-muted-foreground">
							<span class="shrink-0">{m.settings_telegram_link_instruction()}</span>
							<a
								class="min-w-0 truncate text-foreground underline underline-offset-2"
								href={telegramLinkUrl}
								target="_blank"
								rel="noreferrer"
								title={telegramLinkUrl}
							>
								{telegramLinkUrl}
							</a>
						</div>
					{:else}
						<div class="text-sm text-muted-foreground">
							{recipientLinkBusy ? m.settings_telegram_creating_link() : m.settings_telegram_recipient_not_linked()}
						</div>
					{/if}
				</div>

				<div class="flex flex-col gap-2">
					<div class="flex flex-wrap gap-2">
						{#if !telegramRecipientLinked}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={recipientResolveBusy || recipientLinkBusy || !telegramLinkUrl}
								onclick={handleRecipientResolve}
							>
								<CheckIcon class="size-3.5 mr-1.5" />
								{recipientResolveBusy ? m.settings_telegram_checking_message() : m.settings_telegram_check_message()}
							</Button>
						{/if}
							<Button
								type="button"
								variant="outline"
								size="sm"
							disabled={testMessageBusy || !telegramReady}
							onclick={handleTelegramTest}
						>
							<SendIcon class="size-3.5 mr-1.5" />
							{testMessageBusy ? m.settings_telegram_sending() : m.settings_telegram_send_test()}
						</Button>
						{#if telegramRecipientLinked}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={recipientClearBusy}
								onclick={handleRecipientClear}
							>
								<Trash2Icon class="size-3.5 mr-1.5" />
								{m.settings_telegram_clear_recipient()}
							</Button>
						{/if}
					</div>
					<div class="min-w-0 flex flex-col gap-1">
						{#if recipientResult}
							<span class="text-xs {recipientResult.ok ? 'text-accent-foreground' : 'text-destructive'}">
								{recipientResult.message}
							</span>
						{/if}
						{#if testMessageResult}
							<span class="text-xs {testMessageResult.ok ? 'text-accent-foreground' : 'text-destructive'}">
								{testMessageResult.message}
							</span>
						{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
