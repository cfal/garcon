import {
	createApiProvider,
	discoverApiProviderModels,
	testApiProvider,
	updateApiProvider,
} from '$lib/api/api-providers.js';
import type { ModelCatalogStore, ModelOption } from '$lib/agents/model-catalog-store.svelte.js';
import type { ApiProvidersStore } from '$lib/api-providers/api-providers-store.svelte.js';
import { ApiError, isIntermediaryResponse } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import { apiProviderTemplate, type ApiProviderTemplateId } from '$shared/api-provider-templates';
import {
	type ApiProtocol,
	type ApiProviderInput,
	type ModelDiscoveryKind,
	type OpenAiEndpointCapabilities,
} from '$shared/api-providers';

interface DialogOptions {
	readonly modelCatalog: Pick<ModelCatalogStore, 'executorId' | 'forceRefresh'>;
	readonly providers: Pick<ApiProvidersStore, 'findEndpoint' | 'isAssigned' | 'executorIdsFor' | 'invalidate' | 'refresh'>;
	isExecutorReady: () => boolean;
	getProtocol: () => ApiProtocol;
	getEndpointId: () => string | null;
	getTemplateId?: () => ApiProviderTemplateId;
	getDuplicate?: () => boolean;
	onSaved?: () => void;
}

export class ApiProviderEndpointDialogState {
	open = $state(false);
	templateId = $state<ApiProviderTemplateId>('custom');
	label = $state('');
	baseUrl = $state('');
	apiKey = $state('');
	defaultModel = $state('');
	modelsText = $state('');
	supportsImages = $state(false);
	modelDiscovery = $state<ModelDiscoveryKind>('none');
	openAiCapabilities = $state<OpenAiEndpointCapabilities>({
		chatCompletions: true,
		responses: false,
	});
	isSaving = $state(false);
	isTesting = $state(false);
	isFetchingModels = $state(false);
	error = $state<string | null>(null);
	testMessage = $state<string | null>(null);
	apiProviderId = $state<string | null>(null);
	revision = $state<number | undefined>();
	executorIds = $state<string[]>([]);
	#savedExecutorIds: string[] = [];
	#savedDraft = '';
	#saveUnconfirmed = $state(false);
	#duplicateRequiresApiKey = $state(false);
	#savedEndpointId: string | null = null;
	#contextVersion = 0;

	constructor(private readonly options: DialogOptions) {}

	get protocol(): ApiProtocol {
		return this.options.getProtocol();
	}

	get endpointId(): string | null {
		return this.options.getEndpointId();
	}

	get apiKeyPlaceholder(): string {
		if (this.templateId === 'alibaba-cloud')
			return m.settings_api_provider_dialog_api_key_placeholder_alibaba_cloud();
		if (this.templateId === 'fireworks')
			return m.settings_api_provider_dialog_api_key_placeholder_fireworks();
		if (this.templateId === 'gemini')
			return m.settings_api_provider_dialog_api_key_placeholder_gemini();
		if (this.templateId === 'openrouter')
			return m.settings_api_provider_dialog_api_key_placeholder_openrouter();
		if (this.templateId === 'together')
			return m.settings_api_provider_dialog_api_key_placeholder_together();
		if (this.templateId === 'zai') return m.settings_api_provider_dialog_api_key_placeholder_zai();
		if (this.templateId === 'ollama' && !this.#duplicateRequiresApiKey)
			return m.settings_api_provider_dialog_api_key_placeholder_ollama();
		return m.settings_api_provider_dialog_api_key_placeholder();
	}

	get apiKeyRequired(): boolean {
		return this.#duplicateRequiresApiKey || apiProviderTemplate(this.protocol, this.templateId)?.apiKeyRequired === true;
	}

	get title(): string {
		return this.protocol === 'anthropic-messages'
			? m.settings_api_provider_dialog_title_anthropic()
			: m.settings_api_provider_dialog_title_openai();
	}

	get description(): string {
		return this.protocol === 'anthropic-messages'
			? m.settings_api_provider_dialog_description_anthropic()
			: m.settings_api_provider_dialog_description_openai();
	}

	get baseUrlPlaceholder(): string {
		return this.protocol === 'anthropic-messages'
			? m.settings_api_provider_dialog_base_url_placeholder_anthropic()
			: m.settings_api_provider_dialog_base_url_placeholder_openai();
	}

	get usesOpenAiCapabilityToggles(): boolean {
		return this.protocol === 'openai-compatible';
	}

	get supportsChatCompletionsApi(): boolean {
		return this.protocol === 'openai-compatible' && this.openAiCapabilities.chatCompletions;
	}

	get supportsResponsesApi(): boolean {
		return this.protocol === 'openai-compatible' && this.openAiCapabilities.responses;
	}

	get hasRequiredApiCapability(): boolean {
		if (this.protocol !== 'openai-compatible') return true;
		return this.openAiCapabilities.chatCompletions || this.openAiCapabilities.responses;
	}

	get modelOptions(): ModelOption[] {
		return parseModelsText(this.modelsText);
	}

	get hasModels(): boolean {
		return this.modelOptions.length > 0;
	}

	get defaultModelIsValid(): boolean {
		const selected = this.defaultModel.trim();
		return Boolean(selected) && this.modelOptions.some((model) => model.value === selected);
	}

	get defaultModelLabel(): string {
		return (
			this.modelOptions.find((model) => model.value === this.defaultModel)?.label ??
			m.settings_api_provider_dialog_default_model_placeholder()
		);
	}

	get canFetchModels(): boolean {
		return Boolean(
			this.canProbe &&
			this.baseUrl.trim() &&
			(!this.apiKeyRequired || Boolean(this.apiProviderId) || Boolean(this.apiKey.trim())) &&
			!this.isFetchingModels,
		);
	}

	get canTest(): boolean {
		return this.canProbe && this.canSave && !this.isTesting;
	}

	get canProbe(): boolean {
		return this.options.isExecutorReady() && (!this.apiProviderId || Boolean(this.apiKey)
			|| this.options.providers.isAssigned(this.options.modelCatalog.executorId, this.apiProviderId));
	}

	get canSave(): boolean {
		return Boolean(
			this.label.trim() &&
			this.baseUrl.trim() &&
			this.hasModels &&
			this.defaultModelIsValid &&
			this.hasRequiredApiCapability &&
			(!this.apiKeyRequired || Boolean(this.apiProviderId) || Boolean(this.apiKey.trim())) &&
			!this.isSaving &&
			!this.#saveUnconfirmed &&
			!this.isFetchingModels,
		);
	}

	async load(): Promise<void> {
		this.dispose();
		const endpointId = this.endpointId;
		if (!endpointId) {
			this.beginCreate();
			return;
		}

		const found = this.options.providers.findEndpoint(endpointId);
		if (!found) {
			this.error = m.settings_api_provider_dialog_endpoint_missing();
			return;
		}

		this.apiProviderId = found.apiProvider.id;
		this.#savedEndpointId = found.endpoint.id;
		this.revision = found.apiProvider.revision;
		this.label = found.apiProvider.label;
		this.baseUrl = found.endpoint.baseUrl;
		this.defaultModel = found.endpoint.defaultModel;
		this.supportsImages = found.endpoint.supportsImages;
		this.modelDiscovery = found.endpoint.modelDiscovery ?? 'none';
		this.templateId = found.apiProvider.templateId ?? 'custom';
		this.modelsText = found.endpoint.models.map((model) => formatModelLine(model)).join('\n');
		this.openAiCapabilities = this.openAiCapabilitiesFrom(found.endpoint.capabilities);
		this.#savedExecutorIds = this.options.providers.executorIdsFor(found.apiProvider.id);
		this.executorIds = [...this.#savedExecutorIds];
		if (this.options.getDuplicate?.()) {
			this.#duplicateRequiresApiKey = found.endpoint.hasApiKey;
			this.apiProviderId = null;
			this.#savedEndpointId = null;
			this.revision = undefined;
			this.label += ' copy';
			this.#savedExecutorIds = [];
			this.executorIds = [this.options.modelCatalog.executorId];
		}
		this.#savedDraft = JSON.stringify(this.payload());
	}

	dispose(): void {
		this.clearProbeResults();
		this.isSaving = false;
		this.apiKey = '';
		this.#duplicateRequiresApiKey = false;
		this.#saveUnconfirmed = false;
	}

	clearProbeResults(): void {
		this.#contextVersion++;
		this.isTesting = false;
		this.isFetchingModels = false;
		this.testMessage = null;
		this.error = null;
	}

	#isCurrent(catalog: DialogOptions['modelCatalog'], version: number): boolean {
		return this.options.modelCatalog === catalog && this.#contextVersion === version;
	}

	beginCreate(): void {
		this.#duplicateRequiresApiKey = false;
		const template =
			apiProviderTemplate(this.protocol, this.options.getTemplateId?.() ?? 'custom') ??
			apiProviderTemplate(this.protocol, 'custom');
		if (!template) {
			this.error = m.settings_api_provider_dialog_no_template({
				protocol: localizedProtocolLabel(this.protocol),
			});
			return;
		}
		this.apiProviderId = null;
		this.#savedEndpointId = null;
		this.revision = undefined;
		this.executorIds = [this.options.modelCatalog.executorId];
		this.#savedExecutorIds = [];
		this.#savedDraft = '';
		this.templateId = template.id;
		this.label = template.label;
		this.baseUrl = template.baseUrl;
		this.apiKey = '';
		this.defaultModel = template.defaultModel;
		this.modelsText = template.models.map((model) => formatModelLine(model)).join('\n');
		this.supportsImages = template.supportsImages;
		this.modelDiscovery = template.modelDiscovery;
		this.openAiCapabilities = this.openAiCapabilitiesFrom(template.capabilities);
	}

	syncDefaultModelWithModels(): void {
		if (this.defaultModelIsValid) return;
		this.defaultModel = this.modelOptions[0]?.value ?? '';
	}

	setExecutorSelected(executorId: string, selected: boolean): void {
		if (this.isSaving) return;
		this.executorIds = selected
			? [...new Set([...this.executorIds, executorId])]
			: this.executorIds.filter((id) => id !== executorId);
	}

	setSupportsChatCompletionsApi(enabled: boolean): void {
		this.openAiCapabilities = {
			...this.openAiCapabilities,
			chatCompletions: enabled,
		};
	}

	setSupportsResponsesApi(enabled: boolean): void {
		this.openAiCapabilities = {
			...this.openAiCapabilities,
			responses: enabled,
		};
	}

	private openAiCapabilitiesFrom(
		value: OpenAiEndpointCapabilities | undefined,
	): OpenAiEndpointCapabilities {
		if (this.protocol !== 'openai-compatible') {
			return { chatCompletions: false, responses: false };
		}
		return {
			chatCompletions: value?.chatCompletions ?? true,
			responses: value?.responses ?? false,
		};
	}

	payload(): ApiProviderInput {
		return {
			revision: this.revision,
			apiProviderId: this.apiProviderId ?? undefined,
			endpointId: this.#savedEndpointId ?? undefined,
			templateId: this.templateId,
			label: this.label.trim(),
			endpoint: {
				id: this.#savedEndpointId ?? undefined,
				protocol: this.protocol,
				baseUrl: this.baseUrl.trim(),
				apiKey: this.apiKey || undefined,
				...(this.protocol === 'openai-compatible' ? { capabilities: this.openAiCapabilities } : {}),
				defaultModel: this.defaultModel.trim(),
				models: this.modelOptions,
				supportsImages: this.supportsImages,
				modelDiscovery: this.modelDiscovery,
			},
		};
	}

	async save(): Promise<void> {
		if (!this.canSave) return;
		if (this.apiProviderId && !sameExecutorIds(this.#savedExecutorIds, this.options.providers.executorIdsFor(this.apiProviderId))) {
			this.error = 'Executor access changed while this profile was open. Reopen it before saving.';
			return;
		}
		const catalog = this.options.modelCatalog;
		const version = this.#contextVersion;
		this.isSaving = true;
		this.error = null;
		let receivedSave = false;
		try {
			const payload = this.payload();
			const executorIds = [...this.executorIds];
			const profilePatch = JSON.stringify(payload) === this.#savedDraft ? { revision: this.revision } : payload;
			const saved = this.apiProviderId
				? await updateApiProvider(this.apiProviderId, { ...profilePatch, executorIds })
				: await createApiProvider({ ...payload, executorIds });
			receivedSave = true;
			if (this.#contextVersion === version) {
				this.apiProviderId = saved.id;
				this.#savedEndpointId = saved.endpoints[0]?.id ?? null;
				this.revision = saved.revision;
				this.#savedDraft = JSON.stringify(this.payload());
				if (saved.assignment?.status === 'assigned') this.#savedExecutorIds = executorIds;
				this.#saveUnconfirmed = saved.assignment?.status === 'unknown';
			}
			this.options.providers.invalidate();
			await this.options.providers.refresh();
			if (saved.assignment && saved.assignment.status !== 'assigned') {
				throw new Error(saved.assignment.error);
			}
			if (this.#isCurrent(catalog, version) && this.options.isExecutorReady()) await catalog.forceRefresh();
			if (this.#contextVersion !== version) return;
			this.options.onSaved?.();
		} catch (err) {
			this.options.providers.invalidate();
			if (this.#contextVersion === version) {
				this.error = err instanceof Error ? err.message : String(err);
				if (!receivedSave && (!(err instanceof ApiError) || isIntermediaryResponse(err)
					|| err.errorCode === 'API_PROVIDER_STORAGE_UNAVAILABLE')) {
					this.#saveUnconfirmed = true;
					this.error = 'Save could not be confirmed. Close this editor and reload providers before trying again.';
				}
			}
		} finally {
			if (this.#contextVersion === version) this.isSaving = false;
		}
	}

	async fetchModels(): Promise<void> {
		if (!this.canFetchModels) return;
		const catalog = this.options.modelCatalog;
		const version = this.#contextVersion;
		const draft = JSON.stringify(this.payload());
		this.isFetchingModels = true;
		this.error = null;
		this.testMessage = null;
		try {
			const discoveryKind =
				this.modelDiscovery === 'none'
					? discoveryKindForProtocol(this.protocol)
					: this.modelDiscovery;
			const result = await discoverApiProviderModels({
				protocol: this.protocol,
				baseUrl: this.baseUrl.trim(),
				apiKey: this.apiKey || undefined,
				apiProviderId: this.apiProviderId,
				endpointId: this.#savedEndpointId,
				revision: this.revision,
				modelDiscovery: discoveryKind,
			}, catalog.executorId);
			if (!this.#isCurrent(catalog, version) || draft !== JSON.stringify(this.payload())) return;
			if (!result.success) {
				this.error = result.error || m.settings_api_provider_dialog_fetch_failed();
				return;
			}
			if (!result.models?.length) {
				this.error = m.settings_api_provider_dialog_no_models_returned();
				return;
			}
			const sortedModels = sortModelsForDisplay(result.models);
			this.modelsText = sortedModels.map((model) => formatModelLine(model)).join('\n');
			this.modelDiscovery = discoveryKind;
			this.defaultModel = chooseDefaultModel(sortedModels, this.defaultModel);
			this.testMessage = m.settings_api_provider_dialog_models_fetched({
				count: result.models.length,
			});
		} catch (err) {
			if (this.#isCurrent(catalog, version)) this.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (this.#isCurrent(catalog, version)) this.isFetchingModels = false;
		}
	}

	async test(): Promise<void> {
		if (!this.canTest) return;
		const catalog = this.options.modelCatalog;
		const version = this.#contextVersion;
		const draft = JSON.stringify(this.payload());
		this.isTesting = true;
		this.error = null;
		this.testMessage = null;
		try {
			const result = await testApiProvider(this.payload(), catalog.executorId);
			if (!this.#isCurrent(catalog, version) || draft !== JSON.stringify(this.payload())) return;
			if (!result.success) {
				this.error = result.error || m.settings_api_provider_dialog_test_failed();
				return;
			}
			this.testMessage = m.settings_api_provider_dialog_endpoint_accepted({
				protocol: localizedProtocolLabel(this.protocol),
			});
			if (result.models?.length && !this.modelsText.trim()) {
				this.modelsText = result.models.map((model) => formatModelLine(model)).join('\n');
				this.syncDefaultModelWithModels();
			}
		} catch (err) {
			if (this.#isCurrent(catalog, version)) this.error = err instanceof Error ? err.message : String(err);
		} finally {
			if (this.#isCurrent(catalog, version)) this.isTesting = false;
		}
	}
}

function sameExecutorIds(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((id) => right.includes(id));
}

function parseModelsText(text: string): ModelOption[] {
	if (!text.trim()) {
		return [];
	}
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const pipe = line.indexOf('|');
			if (pipe >= 0) {
				return { value: line.slice(0, pipe).trim(), label: line.slice(pipe + 1).trim() };
			}
			return { value: line, label: line };
		})
		.filter((model) => Boolean(model.value && model.label));
}

function formatModelLine(model: ModelOption): string {
	return model.value === model.label ? model.value : `${model.value}|${model.label}`;
}

function sortModelsForDisplay(models: ModelOption[]): ModelOption[] {
	return [...models].sort((left, right) =>
		formatModelLine(left).localeCompare(formatModelLine(right), undefined, {
			numeric: true,
			sensitivity: 'base',
		}),
	);
}

function chooseDefaultModel(models: ModelOption[], current: string): string {
	const selected = current.trim();
	if (selected && models.some((model) => model.value === selected)) return selected;
	return models[0]?.value ?? '';
}

function discoveryKindForProtocol(protocol: ApiProtocol): ModelDiscoveryKind {
	return protocol === 'anthropic-messages' ? 'anthropic-models' : 'openai-models';
}

function localizedProtocolLabel(protocol: ApiProtocol): string {
	return protocol === 'anthropic-messages'
		? m.settings_api_provider_dialog_protocol_anthropic()
		: m.settings_api_provider_dialog_protocol_openai();
}
