import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ApiProviderProtocolPanelTestHarness from './ApiProviderProtocolPanelTestHarness.svelte';

describe('ApiProviderProtocolPanel', () => {
	it('shows protocol-specific Anthropic add-provider templates', async () => {
		render(ApiProviderProtocolPanelTestHarness, {
			protocol: 'anthropic-messages',
			title: 'Anthropic Providers',
			description: 'Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.',
			addLabel: 'Add Anthropic-compatible provider'
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Add Anthropic-compatible provider' }));

		expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
			'Add Alibaba Cloud',
			'Add Fireworks.ai',
			'Add Ollama',
			'Add Z.AI',
			'Add custom provider..'
		]);
		expect(screen.queryByRole('menuitem', { name: 'Add OpenRouter' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Add Together.ai' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Add Gemini' })).toBeNull();
	});

	it('shows protocol-specific OpenAI add-provider templates', async () => {
		render(ApiProviderProtocolPanelTestHarness, {
			protocol: 'openai-chat-completions',
			title: 'OpenAI Providers',
			description: 'Use OpenAI-compatible endpoints with Codex and Direct Chat.',
			addLabel: 'Add OpenAI-compatible provider'
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI-compatible provider' }));

		expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
			'Add Alibaba Cloud',
			'Add Fireworks.ai',
			'Add Gemini',
			'Add Ollama',
			'Add OpenRouter',
			'Add Together.ai',
			'Add Z.AI',
			'Add custom provider..'
		]);
	});

	it('renders saved provider rows without built-in or disabled badges', () => {
		render(ApiProviderProtocolPanelTestHarness, {
			protocol: 'openai-chat-completions',
			title: 'OpenAI Providers',
			description: 'Use OpenAI-compatible endpoints with Codex and Direct Chat.',
			addLabel: 'Add OpenAI-compatible provider',
			apiProviderCatalog: [
				{
					id: 'openrouter',
					label: 'OpenRouter',
					templateId: 'openrouter',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					endpoints: [
						{
							id: 'openrouter_openai',
							protocol: 'openai-chat-completions',
							baseUrl: 'https://openrouter.ai/api/v1',
							exposeTo: ['codex', 'direct-openai-compatible'],
							defaultModel: 'openai/gpt-5.4',
							models: [{ value: 'openai/gpt-5.4', label: 'GPT-5.4' }],
							supportsImages: true,
							hasApiKey: true,
							modelDiscovery: 'openrouter-models'
						}
					]
				}
			]
		});

		expect(screen.getByText('OpenRouter')).toBeTruthy();
		expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy();
		expect(screen.queryByText('builtin')).toBeNull();
		expect(screen.queryByText('Disabled')).toBeNull();
	});
});
