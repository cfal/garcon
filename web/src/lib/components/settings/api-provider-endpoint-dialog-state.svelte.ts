import {
	createApiProvider,
	deleteApiProvider,
	discoverApiProviderModels,
	testApiProvider,
	updateApiProvider,
	type ApiProviderInput,
} from '$lib/api/api-providers.js';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { apiProviderTemplate, type ApiProviderTemplateId } from '$shared/api-provider-templates';
import {
	type ApiProtocol,
	type ModelDiscoveryKind,
	type OpenAiEndpointCapabilities,
} from '$shared/api-providers';

interface DialogOptions {
	modelCatalog: ModelCatalogStore;
	getProtocol: () => ApiProtocol;
	getEndpointId: () => string | null;
	getTemplateId?: () => ApiProviderTemplateId;
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
		if (this.templateId === 'ollama')
			return m.settings_api_provider_dialog_api_key_placeholder_ollama();
		return m.settings_api_provider_dialog_api_key_placeholder();
	}

	get apiKeyRequired(): boolean {
		return apiProviderTemplate(this.protocol, this.templateId)?.apiKeyRequired === true;
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
			this.baseUrl.trim() &&
			(!this.apiKeyRequired || Boolean(this.apiProviderId) || Boolean(this.apiKey.trim())) &&
			!this.isFetchingModels,
		);
	}

	get canTest(): boolean {
		return this.canSave && !this.isTesting;
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
			!this.isFetchingModels,
		);
	}

	async load(): Promise<void> {
		this.error = null;
		this.testMessage = null;
		const endpointId = this.endpointId;
		if (!endpointId) {
			this.beginCreate();
			return;
		}

		const found = this.options.modelCatalog.findEndpoint(endpointId);
		if (!found) {
			this.error = m.settings_api_provider_dialog_endpoint_missing();
			return;
		}

		this.apiProviderId = found.apiProvider.id;
		this.label = found.apiProvider.label;
		this.baseUrl = found.endpoint.baseUrl;
		this.defaultModel = found.endpoint.defaultModel;
		this.supportsImages = found.endpoint.supportsImages;
		this.modelDiscovery = found.endpoint.modelDiscovery ?? 'none';
		this.templateId = found.apiProvider.templateId ?? 'custom';
		this.modelsText = found.endpoint.models.map((model) => formatModelLine(model)).join('\n');
		this.openAiCapabilities = this.openAiCapabilitiesFrom(found.endpoint.capabilities);
		this.apiKey = '';
	}

	beginCreate(): void {
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
			templateId: this.templateId,
			label: this.label.trim(),
			endpoint: {
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
		this.isSaving = true;
		this.error = null;
		try {
			if (this.apiProviderId) {
				await updateApiProvider(this.apiProviderId, this.payload());
			} else {
				await createApiProvider(this.payload());
			}
			await this.options.modelCatalog.refreshApiProviders();
			this.options.onSaved?.();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isSaving = false;
		}
	}

	async fetchModels(): Promise<void> {
		if (!this.canFetchModels) return;
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
				endpointId: this.endpointId,
				modelDiscovery: discoveryKind,
			});
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
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isFetchingModels = false;
		}
	}

	async test(): Promise<void> {
		if (!this.canTest) return;
		this.isTesting = true;
		this.error = null;
		this.testMessage = null;
		try {
			const result = await testApiProvider(this.payload());
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
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isTesting = false;
		}
	}
}

export async function deleteApiProviderEndpoint(
	modelCatalog: ModelCatalogStore,
	endpointId: string,
): Promise<void> {
	const found = modelCatalog.findEndpoint(endpointId);
	if (!found) throw new Error(m.settings_api_provider_dialog_endpoint_missing());
	await deleteApiProvider(found.apiProvider.id);
	await modelCatalog.refreshApiProviders();
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
