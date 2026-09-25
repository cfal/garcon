import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApiProviderProtocolPanelTestHost from './ApiProviderProtocolPanelTestHost.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
import type { ApiProviderCatalogEntry } from '$shared/api-providers';
import type { ExecutorSnapshot } from '$shared/executors';

const workerProfile = {
	id: 'synthetic',
	revision: 1,
	label: 'Worker endpoint',
	createdAt: '',
	updatedAt: '',
	endpoints: [{
		id: 'synthetic_openai',
		protocol: 'openai-compatible',
		baseUrl: 'http://localhost:1234/v1',
		hasApiKey: true,
		supportsImages: false,
		defaultModel: 'synthetic-model',
		models: [{ value: 'synthetic-model', label: 'Synthetic Model' }],
	}],
} satisfies ApiProviderCatalogEntry;

const offlineWorker = { ...remoteExecutor, availability: 'offline' } satisfies ExecutorSnapshot;
const secondWorker = {
	...remoteExecutor,
	id: '33333333-3333-4333-8333-333333333333',
	label: 'Second worker',
} satisfies ExecutorSnapshot;

describe('ApiProviderProtocolPanel', () => {
	afterEach(() => {
		cleanup();
	});

	it.each([
		{ hasApiKey: true, label: 'Key configured' },
		{ hasApiKey: false, label: 'No key' },
	])('shows $label for a saved profile', ({ hasApiKey, label }) => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible', title: 'OpenAI Providers', description: '', addLabel: 'Add provider',
			apiProviderCatalog: [{
				...workerProfile, endpoints: [{ ...workerProfile.endpoints[0], hasApiKey }],
			}],
		});
		expect(screen.getByText(label)).toBeTruthy();
	});

	it.each([
		{
			name: 'prefers a ready assigned executor over an earlier offline assignment',
			executors: [localExecutor, offlineWorker, secondWorker],
			assignments: { [offlineWorker.id]: [workerProfile.id], [secondWorker.id]: [workerProfile.id] },
			expectedExecutorId: secondWorker.id,
		},
		{
			name: 'keeps the assigned executor when it is offline',
			executors: [localExecutor, offlineWorker],
			assignments: { [offlineWorker.id]: [workerProfile.id] },
			expectedExecutorId: offlineWorker.id,
		},
		{
			name: 'uses Local when the profile has no executor assignments',
			executors: [localExecutor, remoteExecutor],
			assignments: {},
			expectedExecutorId: localExecutor.id,
		},
		{
			name: 'keeps Local first when it and a worker are both assigned and ready',
			executors: [localExecutor, remoteExecutor],
			assignments: { local: [workerProfile.id], [remoteExecutor.id]: [workerProfile.id] },
			expectedExecutorId: localExecutor.id,
		},
	] satisfies Array<{
		name: string;
		executors: ExecutorSnapshot[];
		assignments: Record<string, string[]>;
		expectedExecutorId: string;
	}>)('$name', async ({ executors, assignments, expectedExecutorId }) => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description: '',
			addLabel: 'Add provider',
			executors,
			assignments,
			apiProviderCatalog: [workerProfile],
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker endpoint' }));
		const host = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Test from' });
		expect(host.value).toBe(expectedExecutorId);
	});

	it('edits a remote-only profile on its assigned host and preserves input when changing probe hosts', async () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible', title: 'OpenAI Providers', description: '', addLabel: 'Add provider',
			executors: [localExecutor, remoteExecutor],
			assignments: { [remoteExecutor.id]: ['synthetic'] },
			apiProviderCatalog: [workerProfile],
		});
		expect(screen.queryByRole('combobox')).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker endpoint' }));
		const host = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Test from' });
		expect(host.value).toBe(remoteExecutor.id);
		expect(screen.getByRole('button', { name: 'Fetch models' }).hasAttribute('disabled')).toBe(false);
		const label = screen.getByLabelText('Display name') as HTMLInputElement;
		await fireEvent.input(label, { target: { value: 'Unsaved profile label' } });
		await fireEvent.change(host, { target: { value: 'local' } });
		expect(label.value).toBe('Unsaved profile label');
		expect(screen.getByRole('button', { name: 'Fetch models' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.change(host, { target: { value: remoteExecutor.id } });
		expect(screen.getByRole('button', { name: 'Fetch models' }).hasAttribute('disabled')).toBe(false);
	});

	it('keeps create, duplicate, and edit requests independent across dialog openings', async () => {
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description: '',
			addLabel: 'Add provider',
			executors: [localExecutor, remoteExecutor],
			assignments: { [remoteExecutor.id]: [workerProfile.id] },
			apiProviderCatalog: [workerProfile],
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Add Ollama' }));
		expect((await screen.findByLabelText<HTMLInputElement>('Display name')).value).toBe('Ollama');
		expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Create on' }).value).toBe('local');
		await fireEvent.input(screen.getByLabelText('API key or token'), { target: { value: 'synthetic-draft-key' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await fireEvent.click(screen.getByRole('button', { name: 'Duplicate Worker endpoint' }));
		expect((await screen.findByLabelText<HTMLInputElement>('Display name')).value).toBe('Worker endpoint copy');
		expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Create on' }).value).toBe(remoteExecutor.id);
		expect(screen.getByLabelText<HTMLInputElement>('API key or token').value).toBe('');
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
		await fireEvent.input(screen.getByLabelText('API key or token'), { target: { value: 'synthetic-copy-key' } });
		expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await fireEvent.click(screen.getByRole('button', { name: 'Edit Worker endpoint' }));
		expect((await screen.findByLabelText<HTMLInputElement>('Display name')).value).toBe('Worker endpoint');
		expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Test from' }).value).toBe(remoteExecutor.id);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

		await fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Add custom provider..' }));
		expect((await screen.findByLabelText<HTMLInputElement>('Display name')).value).toBe('');
		expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Create on' }).value).toBe('local');
		expect(screen.getByLabelText<HTMLTextAreaElement>('Models').value).toBe('');
	});

	it('restores a failed unassignment and retries revocation on the next click', async () => {
		const unassign = vi.fn(async () => {
			throw new Error('Assignment write failed');
		});
		render(ApiProviderProtocolPanelTestHost, {
			protocol: 'openai-compatible',
			title: 'OpenAI Providers',
			description: '',
			addLabel: 'Add provider',
			unassign,
			apiProviderCatalog: [
				{
					id: 'custom',
					revision: 1,
					label: 'Custom',
					templateId: 'custom',
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z',
					endpoints: [
						{
							id: 'custom_openai',
							protocol: 'openai-compatible',
							baseUrl: 'https://example.test/v1',
							hasApiKey: true,
							supportsImages: false,
							capabilities: { chatCompletions: true, responses: false },
							defaultModel: 'model',
							models: [],
							modelDiscovery: 'none',
						},
					],
				},
			],
		});
		const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Local' });
		expect(checkbox.checked).toBe(true);
		await fireEvent.click(checkbox);
		await screen.findByText('Assignment write failed');
		await waitFor(() => expect(checkbox.closest('fieldset')?.disabled).toBe(false));
		expect(checkbox.checked).toBe(true);
		await fireEvent.click(checkbox);
		await waitFor(() => expect(unassign).toHaveBeenCalledTimes(2));
		expect(unassign).toHaveBeenLastCalledWith('local', 'custom');
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
					revision: 1,
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
					revision: 1,
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
					revision: 1,
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
					revision: 1,
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
