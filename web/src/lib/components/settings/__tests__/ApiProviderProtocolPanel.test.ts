import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ApiProviderProtocolPanelTestHost from './ApiProviderProtocolPanelTestHost.svelte';

describe('ApiProviderProtocolPanel', () => {
	afterEach(() => {
		cleanup();
	});

	it('shows protocol-specific Anthropic add-provider templates', async () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'anthropic-messages',
			title: 'Anthropic Providers',
			description: 'Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.',
			addLabel: 'Add Anthropic-compatible provider',
		});

		await fireEvent.click(
			screen.getByRole('button', { name: 'Add Anthropic-compatible provider' }),
		);

		expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
			'Add Alibaba Cloud',
			'Add Fireworks.ai',
			'Add Ollama',
			'Add Z.AI',
			'Add custom provider..',
		]);
		expect(screen.queryByRole('menuitem', { name: 'Add OpenRouter' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Add Together.ai' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Add Gemini' })).toBeNull();
	});

	it('shows protocol-specific OpenAI add-provider templates', async () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description:
				'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
			addLabel: 'Add OpenAI-compatible provider',
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
			'Add custom provider..',
		]);
	});

	it('opens OpenAI providers with API capability switches instead of agent exposure toggles', async () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description:
				'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
			addLabel: 'Add OpenAI-compatible provider',
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Add OpenAI-compatible provider' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Add custom provider..' }));

		const chatCompletions = await screen.findByRole('switch', {
			name: 'Supports Chat Completions API',
		});
		const responses = screen.getByRole('switch', { name: 'Supports Responses API' });
		expect(chatCompletions.getAttribute('aria-checked')).toBe('true');
		expect(responses.getAttribute('aria-checked')).toBe('false');
		expect(screen.queryByText('Use with Codex')).toBeNull();
		expect(screen.queryByText('Use with Direct (Chat Completions)')).toBeNull();
		expect(screen.queryByText('Use with Direct (Responses)')).toBeNull();
	});

	it('opens Anthropic providers without per-agent exposure switches', async () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'anthropic-messages',
			title: 'Anthropic Providers',
			description: 'Use Anthropic Messages-compatible endpoints with Claude Code and Direct Chat.',
			addLabel: 'Add Anthropic-compatible provider',
		});

		await fireEvent.click(
			screen.getByRole('button', { name: 'Add Anthropic-compatible provider' }),
		);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Add custom provider..' }));

		expect(
			await screen.findByText('Adds an Anthropic Messages endpoint for Claude Code and Direct.'),
		).toBeTruthy();
		expect(screen.queryByText('Use with Claude Code')).toBeNull();
		expect(screen.queryByText('Use with Direct (Anthropic)')).toBeNull();
	});

	it('renders saved provider rows without built-in or disabled badges', () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description:
				'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct can use Chat Completions or Responses; Codex requires Responses API compatibility.',
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
							protocol: 'openai-compatible',
							baseUrl: 'https://openrouter.ai/api/v1',
							capabilities: { chatCompletions: true, responses: true },
							defaultModel: 'openai/gpt-5.4',
							models: [{ value: 'openai/gpt-5.4', label: 'GPT-5.4' }],
							supportsImages: true,
							hasApiKey: true,
							modelDiscovery: 'openrouter-models',
						},
					],
				},
			],
		});

		expect(screen.getByText('OpenRouter')).toBeTruthy();
		expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy();
		expect(screen.queryByText('builtin')).toBeNull();
		expect(screen.queryByText('Disabled')).toBeNull();
	});

	it('renders endpoint rows sorted alphabetically by provider label', () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description:
				'Use OpenAI-compatible endpoints with Codex and Direct Chat. Direct Chat can use Chat Completions or Responses; Codex requires Responses API compatibility.',
			addLabel: 'Add OpenAI-compatible provider',
			apiProviderCatalog: [
				{
					id: 'zebra',
					label: 'Zebra AI',
					templateId: 'custom',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					endpoints: [
						{
							id: 'zebra_openai',
							protocol: 'openai-compatible',
							baseUrl: 'https://zebra.ai/v1',
							capabilities: { chatCompletions: true, responses: false },
							defaultModel: 'zebra-1',
							models: [{ value: 'zebra-1', label: 'Zebra 1' }],
							supportsImages: false,
							hasApiKey: true,
							modelDiscovery: 'openai-models',
						},
					],
				},
				{
					id: 'alpha',
					label: 'Alpha Corp',
					templateId: 'custom',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					endpoints: [
						{
							id: 'alpha_openai',
							protocol: 'openai-compatible',
							baseUrl: 'https://alpha.com/v1',
							capabilities: { chatCompletions: true, responses: false },
							defaultModel: 'alpha-1',
							models: [{ value: 'alpha-1', label: 'Alpha 1' }],
							supportsImages: false,
							hasApiKey: true,
							modelDiscovery: 'openai-models',
						},
					],
				},
				{
					id: 'middle',
					label: 'Middle Inc',
					templateId: 'custom',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					endpoints: [
						{
							id: 'middle_openai',
							protocol: 'openai-compatible',
							baseUrl: 'https://middle.io/v1',
							capabilities: { chatCompletions: true, responses: false },
							defaultModel: 'middle-1',
							models: [{ value: 'middle-1', label: 'Middle 1' }],
							supportsImages: false,
							hasApiKey: true,
							modelDiscovery: 'openai-models',
						},
					],
				},
			],
		});

		const labels = screen
			.getAllByText(/Alpha Corp|Middle Inc|Zebra AI/)
			.map((el) => el.textContent);
		expect(labels).toEqual(['Alpha Corp', 'Middle Inc', 'Zebra AI']);
	});
});
