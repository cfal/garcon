import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewChatFormState } from '../new-chat-form-state.svelte';
import * as chatsApi from '$lib/api/chats';
import * as settingsApi from '$lib/api/settings';

vi.mock('$lib/api/files', () => ({
	browseDirectory: vi.fn()
}));

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn()
}));

vi.mock('$lib/api/settings', () => ({
	getSettings: vi.fn(),
	updateSettings: vi.fn()
}));

const mockAppShell = {
	onNewChatDialogSeed: vi.fn().mockReturnValue(() => {}),
	projectBasePath: '/',
};
const mockModelCatalog = {
	getDefaultModel: vi.fn((provider: string) => {
		if (provider === 'claude') return 'opus';
		if (provider === 'codex') return 'gpt-5.4';
		return '';
	}),
	getModels: vi.fn((provider: string) => {
		if (provider === 'claude') return [{ value: 'opus', label: 'Opus' }];
		if (provider === 'codex') return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
		return [];
	}),
	refreshIfStale: vi.fn().mockResolvedValue(undefined)
};

describe('NewChatFormState', () => {
	let state: NewChatFormState;

	beforeEach(() => {
		vi.useFakeTimers();
			vi.mocked(settingsApi.getSettings).mockResolvedValue({
				ui: {},
				paths: {},
				pinnedChatIds: [],
				lastProvider: 'claude',
				lastProjectPath: '',
				lastModel: 'opus',
				lastPermissionMode: 'default',
				lastThinkingMode: 'none',
			projectBasePath: '/workspace'
		});
		vi.mocked(settingsApi.updateSettings).mockResolvedValue({ success: true });
		state = new NewChatFormState(mockAppShell as any, mockModelCatalog as any);
	});

	it('initializes with default values', () => {
		expect(state.provider).toBe('claude');
		expect(state.validationStatus).toBe('idle');
		expect(state.canSubmit).toBe(false); // Empty path
	});

	it('loads startup defaults from server settings', async () => {
			vi.mocked(settingsApi.getSettings).mockResolvedValue({
				ui: {},
				paths: {},
				pinnedChatIds: [],
				lastProvider: 'codex',
				lastProjectPath: '/workspace/project',
				lastModel: 'gpt-5.4',
				lastPermissionMode: 'acceptEdits',
			lastThinkingMode: 'think-hard',
			projectBasePath: '/workspace'
		});

		await state.loadSettingsAndModels();

		expect(state.settingsLoaded).toBe(true);
		expect(state.provider).toBe('codex');
		expect(state.modelValue).toBe('gpt-5.4');
		expect(state.permissionMode).toBe('acceptEdits');
		expect(state.thinkingMode).toBe('think-hard');
		expect(state.projectPath).toBe('/workspace/project');
	});

	it('debounces directory validation', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({ valid: true, isGitRepo: false });

		// Trigger validation
		state.projectPath = '/fake/path';
		state.validatePath();
		expect(state.validationStatus).toBe('checking');
		expect(chatsApi.validateStart).not.toHaveBeenCalled();

		// Advance time past debounce
		vi.advanceTimersByTime(500);
		
		// Let promises resolve
		await vi.runAllTimersAsync();

		expect(chatsApi.validateStart).toHaveBeenCalledWith('/fake/path');
		expect(state.validationStatus).toBe('valid');
	});

	it('maps outside-base-dir validation errors to a specific message', async () => {
		vi.mocked(chatsApi.validateStart).mockResolvedValue({
			valid: false,
			error: 'Path is outside the allowed base directory',
			errorCode: 'outside_base_dir'
		});

		state.projectPath = '/outside';
		state.validatePath();
		vi.advanceTimersByTime(500);
		await vi.runAllTimersAsync();

		expect(state.validationStatus).toBe('invalid');
		expect(state.validationError).toBe('Path is outside the allowed base directory.');
	});

	it('computes canSubmit correctly', () => {
		// Valid path still requires a first message.
		state.settingsLoaded = true;
		state.projectPath = '/valid/path';
		state.validationStatus = 'valid';
		expect(state.canSubmit).toBe(false);

		state.firstMessage = 'Start this task';
		expect(state.canSubmit).toBe(true);

		// Invalid path
		state.validationStatus = 'invalid';
		expect(state.canSubmit).toBe(false);
	});

	it('rejects submission while startup defaults are still loading', () => {
		state.projectPath = '/valid/path';
		state.validationStatus = 'valid';
		state.firstMessage = 'Start this task';

		expect(state.buildConfig()).toBeNull();
		expect(state.error).toBe('Chat defaults are still loading.');
	});

		it('builds config without persisting startup defaults through app settings', () => {
			state.settingsLoaded = true;
			state.projectPath = '/valid/path';
			state.validationStatus = 'valid';
		state.firstMessage = 'Start this task';
		state.provider = 'codex';
		state.handleModelChange('gpt-5.4');
		state.permissionMode = 'acceptEdits';
		state.thinkingMode = 'think-hard';

		const config = state.buildConfig();

			expect(config).toMatchObject({
				provider: 'codex',
				projectPath: '/valid/path',
				model: 'gpt-5.4',
				permissionMode: 'acceptEdits',
				thinkingMode: 'think-hard',
			});
			expect(settingsApi.updateSettings).not.toHaveBeenCalled();
		});
	});
