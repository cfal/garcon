import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerBottomBar from '../ComposerBottomBar.svelte';

describe('ComposerBottomBar', () => {
	afterEach(cleanup);

	it('hides controls the agent cannot configure', () => {
		render(ComposerBottomBar, {
			canAttachImages: false,
			attachImagesTooltip: 'Unavailable',
			onAddImage: vi.fn(),
			permissionOptions: [
				{
					value: 'bypassPermissions',
					label: 'Bypass Permissions',
					description: 'Runs without permission prompts.',
					iconId: 'permission-bypass',
					toneClass: '',
				},
			],
			selectedPermission: 'bypassPermissions',
			onPermissionSelect: vi.fn(),
			thinkingOptions: [
				{
					value: 'none',
					label: 'Default',
					description: 'Provider default effort.',
					iconId: 'thinking-none',
					toneClass: '',
				},
			],
			selectedThinking: 'none',
			onThinkingSelect: vi.fn(),
			canSend: false,
			onSend: vi.fn(),
			sendTitle: 'Send',
			sendButtonClass: '',
			showAddMenu: false,
			showSendButton: false,
		});

		expect(
			screen.queryByRole('button', { name: 'Permission mode: Bypass Permissions' }),
		).toBeNull();
		expect(screen.queryByRole('button', { name: 'Thinking effort' })).toBeNull();
	});
});
