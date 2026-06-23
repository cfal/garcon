import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import * as settingsApi from '$lib/api/settings';
import NewChatDialogTestHost from './NewChatDialogTestHost.svelte';

vi.mock('$lib/api/chats', () => ({
	validateStart: vi.fn().mockResolvedValue({ valid: true, isGitRepo: false }),
}));

vi.mock('$lib/api/git', () => ({
	getGitWorktrees: vi.fn(),
	gitCreateWorktree: vi.fn(),
}));

vi.mock('$lib/api/settings', () => ({
	getRemoteSettings: vi.fn(),
	updateRemoteSettings: vi.fn(),
}));

function makeSnapshot(): RemoteSettingsSnapshot {
	return {
		version: 1,
		ui: {},
		uiEffective: {},
		paths: {
			pinnedProjectPaths: [],
			browseStartPath: '/workspace',
			recentProjectPaths: ['/workspace'],
		},
		pinnedChatIds: [],
		recentAgentSettings: [
			{
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		],
		executionDefaults: {
			global: {
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
			},
			byAgent: {},
		},
		projectBasePath: '/workspace',
		telegram: {
			botTokenAvailable: false,
			botUsername: null,
			botFirstName: null,
			recipientUsername: null,
			recipientDisplayName: null,
			recipientLinked: false,
			pendingLink: false,
			linkUrl: null,
		},
	};
}

describe('NewChatDialog', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn().mockImplementation(() => ({
				matches: true,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
			})),
		);
		vi.mocked(settingsApi.getRemoteSettings).mockResolvedValue(makeSnapshot());
	});

	afterEach(async () => {
		cleanup();
		await new Promise((resolve) => window.setTimeout(resolve, 30));
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('uses centered dialog positioning on small screens', async () => {
		render(NewChatDialogTestHost);

		await waitFor(() => {
			expect(document.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
		});

		const contentClass = document
			.querySelector('[data-slot="dialog-content"]')
			?.getAttribute('class');

		expect(contentClass).toContain('top-[var(--app-viewport-center-y)]');
		expect(contentClass).toContain('left-[50%]');
		expect(contentClass).toContain('translate-x-[-50%]');
		expect(contentClass).toContain('translate-y-[-50%]');
		expect(contentClass).toContain('w-[calc(100vw-1rem)]');
		expect(contentClass).toContain('max-h-[calc(var(--app-height)-1rem)]');
		expect(contentClass).toContain('sm:top-[50%]');
		expect(contentClass).not.toContain('top-auto');
		expect(contentClass).not.toContain('bottom-0');
		expect(contentClass).not.toContain('translate-y-0');
	});
});
