<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { getRemoteSettings } from '$lib/context';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SaveIcon from '@lucide/svelte/icons/save';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import * as m from '$lib/paraglide/messages.js';
	import { TelegramSettingsState } from './telegram-settings-state.svelte.js';

	const telegram = new TelegramSettingsState(getRemoteSettings());
	const busy = $derived(telegram.operation !== null);
	onDestroy(() => telegram.dispose());
	$effect(() => telegram.autoLink());
</script>

<div class="bg-muted/50 border border-border rounded-lg px-4">
	<div class="flex items-center justify-between py-2 gap-3">
		<div class="min-w-0">
			<div class="text-sm font-medium text-foreground">{m.settings_telegram_notifications()}</div>
		</div>
		<Switch
			bind:checked={() => telegram.active, (next) => void telegram.persistEnabled(Boolean(next))}
			disabled={busy || !telegram.ready}
			aria-label={m.settings_telegram_notifications()}
		/>
	</div>

	{#if telegram.enabledResult}
		<p role="alert" class="text-xs text-destructive">{telegram.enabledResult.message}</p>
	{/if}

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
				placeholder={telegram.botAvailable
					? m.settings_telegram_bot_token_configured()
					: m.settings_telegram_bot_token_placeholder()}
				disabled={telegram.botAvailable || busy}
				value={telegram.token}
				oninput={(e) => {
					telegram.token = (e.currentTarget as HTMLInputElement).value;
				}}
			/>
			<div class="flex flex-wrap gap-2">
				{#if telegram.botAvailable}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onclick={() => void telegram.testToken()}
					>
						<CheckIcon class="size-3.5 mr-1.5" />
						{telegram.operation === 'testToken' ? m.settings_telegram_testing_token() : m.settings_telegram_test_token()}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy}
						onclick={() => void telegram.clearToken()}
					>
						<Trash2Icon class="size-3.5 mr-1.5" />
						{m.settings_telegram_clear_token()}
					</Button>
				{:else}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy || !telegram.token.trim()}
						onclick={() => void telegram.saveToken()}
					>
						<SaveIcon class="size-3.5 mr-1.5" />
						{telegram.operation === 'saveToken' ? m.settings_telegram_saving_token() : m.settings_telegram_save_token()}
					</Button>
				{/if}
			</div>
		</div>
		{#if telegram.tokenResult}
			<span class="text-xs {telegram.tokenResult.ok ? 'text-accent-foreground' : 'text-destructive'}">
				{telegram.tokenResult.message}
			</span>
		{/if}
	</div>

	{#if telegram.botAvailable}
		<div class="flex flex-col gap-2 py-2">
			<div class="min-w-0">
				{#if telegram.recipientLinked && telegram.linkedRecipientLabel}
					<div class="text-sm text-muted-foreground truncate">
						{m.settings_telegram_linked_recipient({ recipient: telegram.linkedRecipientLabel })}
					</div>
				{:else if telegram.linkUrl}
					<div
						class="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-muted-foreground"
					>
						<span class="shrink-0">{m.settings_telegram_link_instruction()}</span>
						<a
							class="min-w-0 truncate text-foreground underline underline-offset-2"
							href={telegram.linkUrl}
							target="_blank"
							rel="noreferrer"
							title={telegram.linkUrl}
						>
							{telegram.linkUrl}
						</a>
					</div>
				{:else}
					<div class="text-sm text-muted-foreground">
						{telegram.operation === 'createLink'
							? m.settings_telegram_creating_link()
							: m.settings_telegram_recipient_not_linked()}
					</div>
				{/if}
			</div>

			<div class="flex flex-col gap-2">
				<div class="flex flex-wrap gap-2">
					{#if !telegram.recipientLinked && !telegram.linkUrl}
						<Button type="button" variant="outline" size="sm" disabled={busy} onclick={() => void telegram.createLink()}>
							{telegram.recipientResult?.ok === false ? m.common_retry() : m.settings_telegram_create_link()}
						</Button>
					{:else if !telegram.recipientLinked}
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy || !telegram.linkUrl}
							onclick={() => void telegram.resolveLink()}
						>
							<CheckIcon class="size-3.5 mr-1.5" />
							{telegram.operation === 'resolveLink'
								? m.settings_telegram_checking_message()
								: m.settings_telegram_check_message()}
						</Button>
					{/if}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={busy || !telegram.ready}
						onclick={() => void telegram.sendTest()}
					>
						<SendIcon class="size-3.5 mr-1.5" />
						{telegram.operation === 'sendTest' ? m.settings_telegram_sending() : m.settings_telegram_send_test()}
					</Button>
					{#if telegram.recipientLinked}
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onclick={() => void telegram.clearRecipient()}
						>
							<Trash2Icon class="size-3.5 mr-1.5" />
							{m.settings_telegram_clear_recipient()}
						</Button>
					{/if}
				</div>
				<div class="min-w-0 flex flex-col gap-1">
					{#if telegram.recipientResult}
						<span
							class="text-xs {telegram.recipientResult.ok ? 'text-accent-foreground' : 'text-destructive'}"
						>
							{telegram.recipientResult.message}
						</span>
					{/if}
					{#if telegram.testMessageResult}
						<span
							class="text-xs {telegram.testMessageResult.ok ? 'text-accent-foreground' : 'text-destructive'}"
						>
							{telegram.testMessageResult.message}
						</span>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>
