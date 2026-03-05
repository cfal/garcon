import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewChatFormState } from '../new-chat-form-state.svelte';
import * as chatsApi from '$lib/api/chats';

vi.mock('$lib/api/files', () => ({
	browseDirectory: vi.fn()
}));

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn()
}));

const mockPreferences = {
	selectedProvider: 'claude',
	claudeModel: 'opus',
	codexModel: 'gpt-5.3-codex',
	opencodeModel: 'gpt-4o',
	permissionMode: 'default',
	thinkingMode: 'none'
};

const mockAppShell = {
	onNewChatDialogSeed: vi.fn().mockReturnValue(() => {})
};
const mockModelCatalog = {
	getDefaultModel: vi.fn((provider: string) => {
		if (provider === 'claude') return 'opus';
		if (provider === 'codex') return 'gpt-5.3-codex';
		return '';
	}),
	getModels: vi.fn(() => []),
	refreshIfStale: vi.fn().mockResolvedValue(undefined)
};

// Also mock context since it might be used inside imports
vi.mock('$lib/context', () => ({
	getAppShell: () => mockAppShell,
	getPreferences: () => mockPreferences
}));

describe('NewChatFormState', () => {
	let state: NewChatFormState;

	beforeEach(() => {
		vi.useFakeTimers();
		state = new NewChatFormState(mockPreferences as any, mockAppShell as any, mockModelCatalog as any);
	});

	it('initializes with default values', () => {
		expect(state.provider).toBe('claude');
		expect(state.validationStatus).toBe('idle');
		expect(state.canSubmit).toBe(false); // Empty path
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
		state.projectPath = '/valid/path';
		state.validationStatus = 'valid';
		expect(state.canSubmit).toBe(false);

		state.firstMessage = 'Start this task';
		expect(state.canSubmit).toBe(true);

		// Invalid path
		state.validationStatus = 'invalid';
		expect(state.canSubmit).toBe(false);
	});
});
