import { describe, expect, it } from 'vitest';
import { detectApiKeyProvider } from '../api-key-provider';

describe('API key provider detection', () => {
	it.each([
		['sk-ant-api03-synthetic_key', 'Anthropic', 'anthropic-messages', 'https://api.anthropic.com'],
		['sk-proj-synthetic_key', 'OpenAI', 'openai-compatible', 'https://api.openai.com/v1'],
		['sk-svcacct-synthetic_key', 'OpenAI', 'openai-compatible', 'https://api.openai.com/v1'],
		['sk-or-v1-synthetic_key', 'OpenRouter', 'openai-compatible', 'https://openrouter.ai/api/v1'],
		[
			'AIzaSynthetic_key1234',
			'Gemini',
			'openai-compatible',
			'https://generativelanguage.googleapis.com/v1beta/openai',
		],
		['gsk_synthetic_key1234', 'Groq', 'openai-compatible', 'https://api.groq.com/openai/v1'],
		['xai-synthetic_key1234', 'xAI', 'openai-compatible', 'https://api.x.ai/v1'],
	])('routes %s only to its recognized service', (key, label, protocol, baseUrl) => {
		expect(detectApiKeyProvider(` ${key}\n`)).toMatchObject({ label, protocol, baseUrl });
	});

	it.each([
		'',
		'sk-ant-api03',
		'sk-ambiguous_synthetic_key',
		'sk-ant-oat01-synthetic_token',
		'Bearer sk-proj-synthetic_key',
		'sk-proj-synthetic_key\nextra',
		'unknown-synthetic_key',
	])('leaves unsupported input for manual setup: %s', (key) => {
		expect(detectApiKeyProvider(key)).toBeNull();
	});
});
