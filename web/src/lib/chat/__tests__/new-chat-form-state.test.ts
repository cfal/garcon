import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewChatFormState } from '../new-chat-form-state.svelte';
import * as clientApi from '$lib/api/client';

vi.mock('$lib/api/client', () => ({
	apiFetch: vi.fn()
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
		vi.mocked(clientApi.apiFetch).mockResolvedValue({ 
			json: () => Promise.resolve({ valid: true }) 
		} as unknown as Response);

		// Trigger validation
		state.projectPath = '/fake/path';
		state.validatePath();
		expect(state.validationStatus).toBe('checking');
		expect(clientApi.apiFetch).not.toHaveBeenCalled();

		// Advance time past debounce
		vi.advanceTimersByTime(500);
		
		// Let promises resolve
		await vi.runAllTimersAsync();

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/files/validate-dir?path=%2Ffake%2Fpath');
		expect(state.validationStatus).toBe('valid');
	});

	it('computes canSubmit correctly', () => {
		// Valid path (no message needed to submit, just a valid path)
		state.projectPath = '/valid/path';
		state.validationStatus = 'valid';
		expect(state.canSubmit).toBe(true);

		// Invalid path
		state.validationStatus = 'invalid';
		expect(state.canSubmit).toBe(false);
	});
});
