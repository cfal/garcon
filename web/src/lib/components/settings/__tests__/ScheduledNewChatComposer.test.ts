import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { NewChatFormState } from '$lib/chat/new-chat-form-state.svelte';
import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';

vi.mock(
	'$lib/components/model-selector/ComposerModelSelector.svelte',
	async () => import('./ComposerModelSelectorTestStub.svelte'),
);

const ScheduledNewChatComposer = (await import('../ScheduledNewChatComposer.svelte')).default;

function makeStartup(): NewChatFormState {
	return {
		agentId: 'claude',
		modelValue: 'opus',
		projectPath: '/workspace/project',
		projectBasePath: '/workspace',
		browseStartPath: '/workspace',
		showBrowser: false,
		validationStatus: 'valid',
		validationError: null,
		isUpdatingPinnedPath: false,
		isPinnedPath: false,
		trimmedPath: '/workspace/project',
		pinnedProjectPaths: [],
		permissionMode: 'default',
		thinkingMode: 'none',
		handlePathFocus: vi.fn(),
		clearError: vi.fn(),
		resetTabCompletions: vi.fn(),
		handleTabCompletion: vi.fn(),
		togglePinnedPath: vi.fn(),
		setPermissionMode: vi.fn(),
		setThinkingMode: vi.fn(),
		selectAgent: vi.fn(),
		handleModelChange: vi.fn(),
	} as unknown as NewChatFormState;
}

function renderComposer(overrides: { prompt?: string; promptError?: string | null } = {}) {
	const onPromptChange = vi.fn();
	const onPromptKeydown = vi.fn();
	const modelCatalog = {
		getSelectableAgents: () => [],
	} as unknown as ModelCatalogStore;
	const remoteSettings = {
		snapshot: { recentAgentSettings: [] },
	} as unknown as RemoteSettingsStore;

	const result = render(ScheduledNewChatComposer, {
		startup: makeStartup(),
		modelCatalog,
		remoteSettings,
		prompt: overrides.prompt ?? '',
		promptError: overrides.promptError ?? null,
		isMobile: false,
		onPromptChange,
		onPromptKeydown,
	});

	return { ...result, onPromptChange, onPromptKeydown };
}

describe('ScheduledNewChatComposer', () => {
	it('keeps the prompt and new-chat controls in one composer surface', () => {
		const { container } = renderComposer();
		const configuration = container.querySelector('[data-slot="scheduled-new-chat-configuration"]');
		const composer = container.querySelector('[data-slot="scheduled-new-chat-composer"]');
		const controls = container.querySelector('[data-slot="scheduled-new-chat-composer-controls"]');
		const prompt = screen.getByRole('textbox', { name: 'Prompt' });
		const projectPath = screen.getByRole('textbox', { name: 'Project Path' });

		expect(configuration).toBeTruthy();
		expect(composer).toBeTruthy();
		expect(composer?.contains(prompt)).toBe(true);
		expect(composer?.contains(controls)).toBe(true);
		expect(controls?.contains(screen.getByRole('button', { name: 'Model selector' }))).toBe(true);
		expect(composer?.contains(projectPath)).toBe(false);
	});

	it('forwards prompt input and keyboard events and renders validation feedback', async () => {
		const { onPromptChange, onPromptKeydown } = renderComposer({
			prompt: '/',
			promptError: 'Slash commands are not supported.',
		});
		const prompt = screen.getByRole('textbox', { name: 'Prompt' });

		expect(screen.getByText('Slash commands are not supported.')).toBeTruthy();

		await fireEvent.input(prompt, { target: { value: 'Review the build' } });
		await fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true });

		expect(onPromptChange).toHaveBeenCalledWith('Review the build');
		expect(onPromptKeydown).toHaveBeenCalledOnce();
	});
});
