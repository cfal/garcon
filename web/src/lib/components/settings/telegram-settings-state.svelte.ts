import { untrack } from 'svelte';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import { ApiError } from '$lib/api/client.js';
import {
	beginTelegramRecipientLink,
	clearTelegramBotToken,
	clearTelegramRecipient,
	resolveTelegramRecipientLink,
	saveTelegramBotToken,
	sendTelegramTest,
	testTelegramBotToken,
	updateRemoteSettings,
} from '$lib/api/settings.js';
import * as m from '$lib/paraglide/messages.js';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
import { errorMessage } from '$lib/utils/error-message.js';

type Operation =
	| 'enable'
	| 'saveToken'
	| 'testToken'
	| 'clearToken'
	| 'createLink'
	| 'resolveLink'
	| 'clearRecipient'
	| 'sendTest';
type Result = { ok: boolean; message: string };
type ResultSlot = 'enabledResult' | 'tokenResult' | 'recipientResult' | 'testMessageResult';

function telegramErrorMessage(error: unknown): string {
	if (!(error instanceof ApiError))
		return errorMessage(error, m.settings_telegram_request_failed());
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

export class TelegramSettingsState {
	#disposed = false;
	#autoLinkAttemptKey: string | undefined;
	token = $state('');
	operation = $state<Operation | null>(null);
	enabledResult = $state.raw<Result | null>(null);
	tokenResult = $state.raw<Result | null>(null);
	recipientResult = $state.raw<Result | null>(null);
	testMessageResult = $state.raw<Result | null>(null);

	#status = $derived.by(() => this.remoteSettings.snapshot?.telegram);
	botAvailable = $derived(this.#status?.botTokenAvailable === true);
	recipientLinked = $derived(this.#status?.recipientLinked === true);
	linkUrl = $derived(this.#status?.linkUrl ?? null);
	ready = $derived(this.botAvailable && this.recipientLinked);
	active = $derived.by(() =>
		this.ready && this.remoteSettings.snapshot?.ui?.notifications?.telegram?.enabled === true,
	);
	linkedRecipientLabel = $derived(
		this.#status?.recipientUsername
			? `@${this.#status.recipientUsername}`
			: (this.#status?.recipientDisplayName ??
					(this.recipientLinked ? m.settings_telegram_linked_account() : '')),
	);

	constructor(
		private readonly remoteSettings: Pick<RemoteSettingsStore, 'snapshot' | 'applySnapshot'>,
	) {}

	dispose(): void {
		this.#disposed = true;
	}

	autoLink(): void {
		if (!this.botAvailable) {
			this.#autoLinkAttemptKey = undefined;
			return;
		}
		if (this.recipientLinked || this.linkUrl || this.operation) return;
		const key = this.#status?.botUsername ?? 'configured';
		if (key === this.#autoLinkAttemptKey) return;
		this.#autoLinkAttemptKey = key;
		untrack(() => void this.createLink());
	}

	async persistEnabled(enabled: boolean): Promise<void> {
		if (!this.ready) return;
		await this.#runMutation(
			'enable',
			'enabledResult',
			() => updateRemoteSettings({ ui: { notifications: { telegram: { enabled } } } }),
		);
	}

	async saveToken(): Promise<void> {
		const token = this.token.trim();
		if (!token || this.botAvailable) return;
		await this.#runMutation(
			'saveToken',
			'tokenResult',
			() => saveTelegramBotToken(token),
			() => {
				this.token = '';
				this.recipientResult = null;
			},
		);
	}

	async testToken(): Promise<void> {
		if (!this.botAvailable) return;
		await this.#run(
			'testToken',
			'tokenResult',
			() => testTelegramBotToken(),
			(response) => {
				this.tokenResult = {
					ok: true,
					message: m.settings_telegram_token_valid_for({ username: `@${response.bot.username}` }),
				};
			},
		);
	}

	async clearToken(): Promise<void> {
		if (!this.botAvailable) return;
		await this.#runMutation('clearToken', 'tokenResult', clearTelegramBotToken, () => {
			this.token = '';
			this.recipientResult = null;
			this.tokenResult = { ok: true, message: m.settings_telegram_token_cleared() };
		});
	}

	async createLink(): Promise<void> {
		if (!this.botAvailable || this.recipientLinked || this.linkUrl) return;
		await this.#runMutation('createLink', 'recipientResult', beginTelegramRecipientLink);
	}

	async resolveLink(): Promise<void> {
		if (!this.linkUrl) return;
		await this.#runMutation('resolveLink', 'recipientResult', resolveTelegramRecipientLink, (response) => {
			this.recipientResult = response.success
				? { ok: true, message: m.settings_telegram_recipient_linked() }
				: { ok: false, message: response.error ?? m.settings_telegram_link_not_found() };
		});
	}

	async clearRecipient(): Promise<void> {
		if (!this.recipientLinked && !this.linkUrl) return;
		await this.#runMutation('clearRecipient', 'recipientResult', clearTelegramRecipient, () => {
			this.recipientResult = { ok: true, message: m.settings_telegram_recipient_cleared() };
		});
	}

	async sendTest(): Promise<void> {
		if (!this.ready) return;
		await this.#run('sendTest', 'testMessageResult', sendTelegramTest, (response) => {
			this.testMessageResult = response.success
				? { ok: true, message: m.settings_telegram_test_sent() }
				: { ok: false, message: response.error ?? m.settings_telegram_send_failed() };
		});
	}

	#runMutation<T extends { settings: RemoteSettingsSnapshot }>(
		operation: Operation,
		slot: ResultSlot,
		request: () => Promise<T>,
		publish?: (response: T) => void,
	): Promise<void> {
		return this.#run(operation, slot, async () => {
			const response = await request();
			this.remoteSettings.applySnapshot(response.settings);
			return response;
		}, publish);
	}

	async #run<T>(
		operation: Operation,
		slot: ResultSlot,
		request: () => Promise<T>,
		publish?: (response: T) => void,
	): Promise<void> {
		if (this.#disposed || this.operation) return;
		this.operation = operation;
		this[slot] = null;
		try {
			const response = await request();
			if (!this.#disposed) publish?.(response);
		} catch (error) {
			if (!this.#disposed) this[slot] = { ok: false, message: telegramErrorMessage(error) };
		} finally {
			if (!this.#disposed) this.operation = null;
		}
	}
}
