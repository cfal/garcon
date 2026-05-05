import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { RemoteSettingsSnapshot } from '$shared/settings';
import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
import RemoteSettingsSectionTestHarness from './RemoteSettingsSectionTestHarness.svelte';
import { setTestRemoteSettingsStore } from './remote-settings-test-context';

function makeSnapshot(overrides: Partial<RemoteSettingsSnapshot> = {}): RemoteSettingsSnapshot {
	return {
		version: 1,
		ui: {},
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '' },
		pinnedChatIds: [],
		lastProvider: 'claude',
		lastProjectPath: '',
		lastModel: 'opus',
		lastApiProviderId: null,
		lastModelEndpointId: null,
		lastModelProtocol: null,
		lastPermissionMode: 'default',
		lastThinkingMode: 'none',
		lastClaudeThinkingMode: 'auto',
		lastAmpAgentMode: 'smart',
		projectBasePath: '/workspace',
		telegramBotTokenAvailable: false,
		...overrides,
	};
}

describe('RemoteSettingsSection', () => {
	it('preserves an unsaved telegram chat ID while newer snapshots arrive', async () => {
		const store = new RemoteSettingsStore();
		store.applySnapshot(
			makeSnapshot({
				version: 1,
				ui: {
					notifications: {
						telegram: {
							enabled: true,
							chatId: '123',
						},
					},
				},
				telegramBotTokenAvailable: true,
			}),
		);
		setTestRemoteSettingsStore(store);

		render(RemoteSettingsSectionTestHarness);

		const input = await screen.findByDisplayValue('123');
		await fireEvent.focus(input);
		await fireEvent.input(input, { target: { value: '999' } });

		store.applySnapshot(
			makeSnapshot({
				version: 2,
				ui: {
					pinnedInsertPosition: 'bottom',
					notifications: {
						telegram: {
							enabled: true,
							chatId: '123',
						},
					},
				},
				telegramBotTokenAvailable: true,
			}),
		);

		expect(await screen.findByDisplayValue('999')).toBeTruthy();
	});
});
