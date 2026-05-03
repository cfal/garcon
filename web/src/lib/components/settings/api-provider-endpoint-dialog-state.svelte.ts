import {
	createApiProvider,
	deleteApiProvider,
	testApiProvider,
	updateApiProvider,
	type ApiProviderInput
} from '$lib/api/providers.js';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte.js';
import {
	apiProviderTemplate,
	type ApiProviderTemplateId
} from '$shared/api-provider-templates';
import {
	harnessesForProtocol,
	labelForProtocol,
	type ApiProtocol,
	type HarnessId,
	type ModelDiscoveryKind
} from '$shared/providers';

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
	enabledTargets = $state<Record<string, boolean>>({});
	isSaving = $state(false);
	isTesting = $state(false);
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
		return apiProviderTemplate(this.protocol, this.templateId)?.apiKeyPlaceholder ?? 'API key or token';
	}

	get apiKeyRequired(): boolean {
		return apiProviderTemplate(this.protocol, this.templateId)?.apiKeyRequired === true;
	}

	get title(): string {
		return this.protocol === 'anthropic-messages'
			? 'Anthropic-compatible API provider'
			: 'OpenAI-compatible API provider';
	}

	get description(): string {
		return this.protocol === 'anthropic-messages'
			? 'Adds an Anthropic Messages endpoint for Claude Code.'
			: 'Adds an OpenAI-compatible endpoint for Codex and Direct Chat.';
	}

	get baseUrlPlaceholder(): string {
		return this.protocol === 'anthropic-messages'
			? 'https://api.example.com/anthropic'
			: 'https://api.example.com/v1';
	}

	get targetOptions(): Array<{ harnessId: HarnessId; label: string; description: string }> {
		return harnessesForProtocol(this.protocol).map((harnessId) => ({
			harnessId,
			label: labelForHarnessTarget(harnessId),
			description: descriptionForHarnessTarget(harnessId)
		}));
	}

	get exposeTo(): HarnessId[] {
		return this.targetOptions
			.filter((target) => this.enabledTargets[target.harnessId] !== false)
			.map((target) => target.harnessId);
	}

	get canSave(): boolean {
		return Boolean(
			this.label.trim() &&
				this.baseUrl.trim() &&
				this.defaultModel.trim() &&
				this.exposeTo.length > 0 &&
				(!this.apiKeyRequired || Boolean(this.apiProviderId) || Boolean(this.apiKey.trim())) &&
				!this.isSaving
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
			this.error = 'Endpoint no longer exists.';
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
		this.enabledTargets = Object.fromEntries(
			this.targetOptions.map((target) => [
				target.harnessId,
				found.endpoint.exposeTo.includes(target.harnessId)
			])
		);
		this.apiKey = '';
	}

	beginCreate(): void {
		const template = apiProviderTemplate(this.protocol, this.options.getTemplateId?.() ?? 'custom')
			?? apiProviderTemplate(this.protocol, 'custom');
		if (!template) {
			this.error = `No provider template is available for ${labelForProtocol(this.protocol)} endpoints.`;
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
		this.enabledTargets = Object.fromEntries(
			this.targetOptions.map((target) => [target.harnessId, template.exposeTo.includes(target.harnessId)])
		);
	}

	isTargetEnabled(harnessId: HarnessId): boolean {
		return this.enabledTargets[harnessId] !== false;
	}

	setTarget(harnessId: HarnessId, enabled: boolean): void {
		this.enabledTargets = { ...this.enabledTargets, [harnessId]: enabled };
	}

	payload(): ApiProviderInput {
		return {
			templateId: this.templateId,
			label: this.label.trim(),
			endpoint: {
				protocol: this.protocol,
				baseUrl: this.baseUrl.trim(),
				apiKey: this.apiKey || undefined,
				exposeTo: this.exposeTo,
				defaultModel: this.defaultModel.trim(),
				models: parseModelsText(this.modelsText, this.defaultModel),
				supportsImages: this.supportsImages,
				modelDiscovery: this.modelDiscovery
			}
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
			await this.options.modelCatalog.forceRefresh();
			this.options.onSaved?.();
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isSaving = false;
		}
	}

	async test(): Promise<void> {
		this.isTesting = true;
		this.error = null;
		this.testMessage = null;
		try {
			const result = await testApiProvider(this.payload());
			if (!result.success) {
				this.error = result.error || 'Provider test failed.';
				return;
			}
			this.testMessage = `${labelForProtocol(this.protocol)} endpoint accepted.`;
			if (result.models?.length && !this.modelsText.trim()) {
				this.modelsText = result.models.map((model) => formatModelLine(model)).join('\n');
			}
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.isTesting = false;
		}
	}
}

export async function deleteApiProviderEndpoint(modelCatalog: ModelCatalogStore, endpointId: string): Promise<void> {
	const found = modelCatalog.findEndpoint(endpointId);
	if (!found) throw new Error('Endpoint no longer exists.');
	await deleteApiProvider(found.apiProvider.id);
	await modelCatalog.forceRefresh();
}

function parseModelsText(text: string, defaultModel: string): Array<{ value: string; label: string }> {
	if (!text.trim()) {
		return [{ value: defaultModel, label: defaultModel }];
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
		});
}

function formatModelLine(model: ModelOption): string {
	return model.value === model.label ? model.value : `${model.value}|${model.label}`;
}

function labelForHarnessTarget(harnessId: HarnessId): string {
	if (harnessId === 'claude') return 'Use with Claude Code';
	if (harnessId === 'codex') return 'Use with Codex';
	if (harnessId === 'direct-openai-compatible') return 'Use with Direct Chat';
	return `Use with ${harnessId}`;
}

function descriptionForHarnessTarget(harnessId: HarnessId): string {
	if (harnessId === 'claude') return 'Routes Claude Code through this Anthropic-compatible endpoint.';
	if (harnessId === 'codex') return 'Routes Codex through this OpenAI-compatible endpoint.';
	if (harnessId === 'direct-openai-compatible') return 'Makes models available in direct chat.';
	return 'Makes models available to this harness.';
}
