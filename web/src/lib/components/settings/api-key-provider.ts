import { apiProviderTemplate, type ApiProviderTemplate } from '$shared/api-provider-templates';
import type { ApiProtocol } from '$shared/api-providers';

function customProvider(
	label: string,
	protocol: ApiProtocol,
	baseUrl: string,
	responses = false,
): ApiProviderTemplate {
	return {
		id: 'custom',
		protocol,
		label,
		baseUrl,
		apiKeyPlaceholder: 'API key',
		apiKeyRequired: true,
		defaultModel: '',
		models: [],
		supportsImages: false,
		modelDiscovery: protocol === 'anthropic-messages' ? 'anthropic-models' : 'openai-models',
		...(protocol === 'openai-compatible'
			? { capabilities: { chatCompletions: true, responses } }
			: {}),
	};
}

// Ambiguous legacy sk- keys require manual provider selection.
export function detectApiKeyProvider(input: string): ApiProviderTemplate | null {
	const key = input.trim();
	if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length <= 16) return null;
	if (key.startsWith('sk-ant-api'))
		return customProvider('Anthropic', 'anthropic-messages', 'https://api.anthropic.com');
	if (key.startsWith('sk-or-v1-')) return apiProviderTemplate('openai-compatible', 'openrouter');
	if (key.startsWith('sk-proj-') || key.startsWith('sk-svcacct-'))
		return customProvider('OpenAI', 'openai-compatible', 'https://api.openai.com/v1', true);
	if (key.startsWith('AIza')) return apiProviderTemplate('openai-compatible', 'gemini');
	if (key.startsWith('gsk_'))
		return customProvider('Groq', 'openai-compatible', 'https://api.groq.com/openai/v1');
	if (key.startsWith('xai-'))
		return customProvider('xAI', 'openai-compatible', 'https://api.x.ai/v1');
	return null;
}

export interface ApiKeyProviderDraft {
	readonly template: ApiProviderTemplate;
	readonly apiKey: string;
}
