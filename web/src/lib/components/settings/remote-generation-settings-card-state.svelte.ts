import { testGenerationModel } from '$lib/api/settings.js';
import { ApiError } from '$lib/api/client.js';
import type {
	ModelSelectorChange,
	ModelSelectorValue,
} from '$lib/components/model-selector/model-selector-types';
import { DEFAULT_COMMIT_MESSAGE_PROMPT } from '$lib/git/commit/commit-message-default-prompt.js';
import * as m from '$lib/paraglide/messages.js';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import type { SessionAgentId } from '$lib/types/app';
import type { ApiProtocol } from '$shared/api-providers';
import { normalizeThinkingMode } from '$shared/chat-modes';
import { generationModelTestConfigurationKey } from '$shared/generation-test-contracts';
import type { GenerationUiSettings, RemoteUiSettings } from '$shared/settings';

export type GenerationSettingsKey = 'chatTitle' | 'commitMessage';

interface RemoteGenerationSettingsCardOptions {
	remoteSettings: RemoteSettingsStore;
	modelCatalog: ModelCatalogStore;
	get settingsKey(): GenerationSettingsKey;
	get enabledLabel(): string | undefined;
	get showPrompt(): boolean;
}

interface ConfigurationTestResult {
	configurationKey: string;
	durationMs: number;
}

interface ConfigurationTestError {
	configurationKey: string;
	message: string;
}

export class RemoteGenerationSettingsCardState {
	saveError = $state<string | null>(null);
	pendingSaveCount = $state(0);
	selectionOverride = $state<ModelSelectorValue | null>(null);
	testing = $state(false);
	testError = $state<ConfigurationTestError | null>(null);
	testResult = $state<ConfigurationTestResult | null>(null);
	promptDraft = $state(DEFAULT_COMMIT_MESSAGE_PROMPT);
	#selectionSaveToken = 0;
	#testRequestToken = 0;
	#promptHydrationKey = '';

	constructor(private readonly options: RemoteGenerationSettingsCardOptions) {}

	get hasEnabledSwitch(): boolean {
		return this.options.settingsKey === 'chatTitle' && Boolean(this.options.enabledLabel);
	}

	get persistedSettings(): GenerationUiSettings {
		return this.options.remoteSettings.snapshot?.ui?.[this.options.settingsKey] ?? {};
	}

	get effectiveSettings(): GenerationUiSettings {
		return this.options.remoteSettings.snapshot?.uiEffective?.[this.options.settingsKey] ?? {};
	}

	get enabled(): boolean {
		return this.hasEnabledSwitch ? this.effectiveSettings.enabled !== false : true;
	}

	get provider(): SessionAgentId {
		return (
			this.selectionOverride?.agentId ??
			(this.effectiveSettings.agentId as SessionAgentId) ??
			'claude'
		);
	}

	get rawModel(): string {
		return this.effectiveSettings.model ?? '';
	}

	get modelEndpointId(): string | null {
		return this.selectionOverride?.modelEndpointId ?? this.effectiveSettings.modelEndpointId ?? null;
	}

	get modelProtocol(): ApiProtocol | null {
		return this.selectionOverride?.modelProtocol ?? this.effectiveSettings.modelProtocol ?? null;
	}

	get apiProviderId(): string | null {
		return this.selectionOverride?.apiProviderId ?? this.effectiveSettings.apiProviderId ?? null;
	}

	get thinkingMode() {
		return (
			this.selectionOverride?.thinkingMode ??
			normalizeThinkingMode(this.effectiveSettings.thinkingMode)
		);
	}

	get modelValue(): string {
		return (
			this.selectionOverride?.model ??
			this.options.modelCatalog.selectionValueFor(
				this.provider,
				this.rawModel,
				this.modelEndpointId,
			)
		);
	}

	get selectorValue(): ModelSelectorValue {
		return {
			agentId: this.provider,
			model: this.modelValue,
			apiProviderId: this.apiProviderId,
			modelEndpointId: this.modelEndpointId,
			modelProtocol: this.modelProtocol,
			thinkingMode: this.thinkingMode,
		};
	}

	get isSaving(): boolean {
		return this.pendingSaveCount > 0;
	}

	get configurationKey(): string {
		const configuration = this.selectionOverride
			? this.options.modelCatalog.selectionFor(
					this.provider,
					this.modelValue,
					this.modelEndpointId,
				)
			: {
					model: this.rawModel,
					apiProviderId: this.apiProviderId,
					modelEndpointId: this.modelEndpointId,
					modelProtocol: this.modelProtocol,
				};
		return generationModelTestConfigurationKey({
			agentId: this.provider,
			...configuration,
			thinkingMode: this.thinkingMode,
		});
	}

	get testButtonLabel(): string {
		return this.options.settingsKey === 'chatTitle'
			? m.settings_chat_title_model_test()
			: m.settings_commit_message_model_test();
	}

	get visibleTestResult(): ConfigurationTestResult | null {
		return this.testResult?.configurationKey === this.configurationKey ? this.testResult : null;
	}

	get visibleTestError(): string | null {
		return this.testError?.configurationKey === this.configurationKey
			? this.testError.message
			: null;
	}

	get directoryPrefixEnabled(): boolean {
		return this.effectiveSettings.useCommonDirPrefix === true;
	}

	get isDefaultPrompt(): boolean {
		return (
			this.promptDraft.trim().length === 0 ||
			this.promptDraft === DEFAULT_COMMIT_MESSAGE_PROMPT
		);
	}

	syncPromptDraft(): void {
		if (!this.options.showPrompt) return;
		const snapshotVersion = this.options.remoteSettings.snapshot?.version ?? 0;
		const persistedPrompt =
			typeof this.persistedSettings.customPrompt === 'string'
				? this.persistedSettings.customPrompt
				: '';
		const nextHydrationKey = `${this.options.settingsKey}:${snapshotVersion}:${persistedPrompt}`;
		if (this.#promptHydrationKey === nextHydrationKey) return;
		this.promptDraft = persistedPrompt.trim()
			? persistedPrompt
			: DEFAULT_COMMIT_MESSAGE_PROMPT;
		this.#promptHydrationKey = nextHydrationKey;
	}

	async persistSettings(overrides: GenerationUiSettings = {}): Promise<boolean> {
		const nextProvider =
			typeof overrides.agentId === 'string'
				? (overrides.agentId as SessionAgentId)
				: this.provider;
		const nextModelValue = typeof overrides.model === 'string' ? overrides.model : this.modelValue;
		const nextEndpointId =
			overrides.modelEndpointId !== undefined
				? overrides.modelEndpointId
				: this.modelEndpointId;
		const selection = this.options.modelCatalog.selectionFor(
			nextProvider,
			nextModelValue,
			nextEndpointId,
		);
		const nextSettings: GenerationUiSettings = {
			...this.persistedSettings,
			...overrides,
			agentId: nextProvider,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
			thinkingMode:
				overrides.thinkingMode !== undefined
					? normalizeThinkingMode(overrides.thinkingMode)
					: this.thinkingMode,
		};
		if (this.hasEnabledSwitch) {
			nextSettings.enabled =
				typeof overrides.enabled === 'boolean' ? overrides.enabled : this.enabled;
		}
		return this.#saveGenerationSettings(nextSettings);
	}

	async persistSelection(next: ModelSelectorChange): Promise<void> {
		const previousOverride = this.selectionOverride;
		const token = ++this.#selectionSaveToken;
		this.selectionOverride = {
			agentId: next.agentId,
			model: next.modelValue,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
			thinkingMode: normalizeThinkingMode(next.thinkingMode),
		};

		const nextSettings: GenerationUiSettings = {
			...this.persistedSettings,
			agentId: next.agentId,
			model: next.model,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
			thinkingMode: normalizeThinkingMode(next.thinkingMode),
		};
		if (this.hasEnabledSwitch) nextSettings.enabled = this.enabled;
		const saved = await this.#saveGenerationSettings(nextSettings);
		if (token !== this.#selectionSaveToken) return;
		this.selectionOverride = saved ? null : previousOverride;
	}

	async persistPromptDraft(): Promise<void> {
		await this.persistSettings({
			customPrompt: this.isDefaultPrompt ? '' : this.promptDraft,
		});
	}

	async restoreDefaultPrompt(): Promise<void> {
		this.promptDraft = DEFAULT_COMMIT_MESSAGE_PROMPT;
		await this.persistSettings({ customPrompt: '' });
	}

	formatDuration(durationMs: number): string {
		if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
		return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(durationMs / 1_000)} s`;
	}

	async runGenerationModelTest(): Promise<void> {
		if (this.isSaving || this.testing) return;
		const token = ++this.#testRequestToken;
		const testedConfigurationKey = this.configurationKey;
		this.testing = true;
		this.testError = null;
		this.testResult = null;
		try {
			const result = await testGenerationModel(
				this.options.settingsKey,
				testedConfigurationKey,
			);
			if (token !== this.#testRequestToken) return;
			this.testResult = {
				configurationKey: testedConfigurationKey,
				durationMs: result.durationMs,
			};
		} catch (error) {
			if (token !== this.#testRequestToken) return;
			this.testError = {
				configurationKey: testedConfigurationKey,
				message: this.#generationTestErrorMessage(error),
			};
		} finally {
			if (token === this.#testRequestToken) this.testing = false;
		}
	}

	#settingsForSave(settings: GenerationUiSettings): GenerationUiSettings {
		const nextSettings = { ...settings };
		if (!this.hasEnabledSwitch) delete nextSettings.enabled;
		return nextSettings;
	}

	async #saveGenerationSettings(nextSettings: GenerationUiSettings): Promise<boolean> {
		this.saveError = null;
		this.pendingSaveCount += 1;
		try {
			const ui = {
				[this.options.settingsKey]: this.#settingsForSave(nextSettings),
			} as Partial<RemoteUiSettings>;
			await this.options.remoteSettings.update({ ui });
			return true;
		} catch (error) {
			this.saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		} finally {
			this.pendingSaveCount -= 1;
		}
	}

	#generationTestErrorMessage(error: unknown): string {
		if (error instanceof ApiError) {
			switch (error.errorCode) {
				case 'GENERATION_TEST_UNAVAILABLE':
					return m.settings_generation_model_test_unavailable();
				case 'GENERATION_TEST_CONFIGURATION_CHANGED':
					return m.settings_generation_model_test_configuration_changed();
				case 'GENERATION_TEST_UNSUPPORTED_EFFORT':
					return m.settings_generation_model_test_unsupported_effort();
				case 'GENERATION_TEST_EMPTY_RESPONSE':
					return m.settings_generation_model_test_empty();
				case 'GENERATION_TEST_TIMEOUT':
					return m.settings_generation_model_test_timeout();
			}
		}
		if (
			error instanceof DOMException &&
			(error.name === 'AbortError' || error.name === 'TimeoutError')
		) {
			return m.settings_generation_model_test_timeout();
		}
		return m.settings_generation_model_test_failed();
	}
}
