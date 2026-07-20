import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
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
		gitRepoStatus: 'git',
		isUpdatingPinnedPath: false,
		isPinnedPath: false,
		trimmedPath: '/workspace/project',
		pinnedProjectPaths: [],
		chatTags: [],
		showTagInput: false,
		permissionMode: 'default',
		thinkingMode: 'none',
		permissionModes: ['default', 'acceptEdits', 'manualBypass', 'bypassPermissions'],
		thinkingModes: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
		agentSettingDescriptors: [],
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		handlePathFocus: vi.fn(),
		clearError: vi.fn(),
		resetTabCompletions: vi.fn(),
		handleTabCompletion: vi.fn(),
		togglePinnedPath: vi.fn(),
		toggleTagInput: vi.fn(),
		addTag: vi.fn(() => true),
		removeTag: vi.fn(),
		openWorktreeModal: vi.fn(),
		worktreeModalOpen: false,
		worktreeItems: [],
		isLoadingWorktrees: false,
		isCreatingWorktree: false,
		worktreeError: null,
		selectWorktree: vi.fn(),
		createWorktree: vi.fn(),
		loadWorktrees: vi.fn(),
		closeWorktreeModal: vi.fn(),
		setPermissionMode: vi.fn(),
		setThinkingMode: vi.fn(),
		setAgentSetting: vi.fn(),
		selectAgent: vi.fn(),
		handleModelChange: vi.fn(),
	} as unknown as NewChatFormState;
}

function renderComposer(overrides: { prompt?: string; promptError?: string | null } = {}) {
	const onPromptChange = vi.fn();
	const onPromptKeydown = vi.fn();
	const startup = makeStartup();
	const modelCatalog = {
		getSelectableAgents: () => [],
	} as unknown as ModelCatalogStore;
	const remoteSettings = {
		snapshot: { recentAgentSettings: [] },
	} as unknown as RemoteSettingsStore;

	const result = render(ScheduledNewChatComposer, {
		startup,
		modelCatalog,
		remoteSettings,
		prompt: overrides.prompt ?? '',
		promptError: overrides.promptError ?? null,
		knownTags: ['qa', 'review-needed'],
		isMobile: false,
		onPromptChange,
		onPromptKeydown,
	});

	return { ...result, startup, onPromptChange, onPromptKeydown };
}

describe('ScheduledNewChatComposer', () => {
	it('keeps the prompt and new-chat controls in one composer surface', async () => {
		const { container, startup } = renderComposer();
		const configuration = container.querySelector('[data-slot="scheduled-new-chat-configuration"]');
		const composer = container.querySelector('[data-slot="scheduled-new-chat-composer"]');
		const controls = container.querySelector('[data-slot="scheduled-new-chat-composer-controls"]');
		const prompt = screen.getByRole('textbox', { name: 'Prompt' });
		const projectPath = screen.getByRole('textbox', { name: 'Project Path' });
		const selectWorktree = screen.getByRole('button', { name: 'Select a different worktree' });
		const addTags = screen.getByRole('button', { name: 'Add tags' });

		expect(configuration).toBeTruthy();
		expect(composer).toBeTruthy();
		expect(composer?.className).not.toContain('pb-1.5');
		expect(composer?.contains(prompt)).toBe(true);
		expect(composer?.contains(controls)).toBe(true);
		expect(controls?.contains(screen.getByRole('button', { name: 'Model selector' }))).toBe(true);
		expect(composer?.contains(projectPath)).toBe(false);

		await fireEvent.click(selectWorktree);
		expect(startup.openWorktreeModal).toHaveBeenCalledOnce();
		await fireEvent.click(addTags);
		expect(startup.toggleTagInput).toHaveBeenCalledOnce();
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
