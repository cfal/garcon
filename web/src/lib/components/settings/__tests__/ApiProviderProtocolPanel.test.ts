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

		expect(await screen.findByRole('menuitem', { name: 'Add Z.AI' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Add Ollama' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Add custom provider..' })).toBeTruthy();
		expect(screen.queryByRole('menuitem', { name: 'Add OpenRouter' })).toBeNull();
	});

	it('shows protocol-specific OpenAI add-provider templates', async () => {
		render(ApiProviderProtocolPanelTestHarness, {
			protocol: 'openai-chat-completions',
			title: 'OpenAI Providers',
			description: 'Use OpenAI-compatible endpoints with Codex and Direct Chat.',
			addLabel: 'Add OpenAI-compatible provider'
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI-compatible provider' }));

		expect(await screen.findByRole('menuitem', { name: 'Add OpenRouter' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Add Z.AI' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Add Ollama' })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: 'Add custom provider..' })).toBeTruthy();
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
