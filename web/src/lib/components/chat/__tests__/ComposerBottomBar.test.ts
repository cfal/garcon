import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerBottomBar from '../ComposerBottomBar.svelte';

describe('ComposerBottomBar', () => {
	afterEach(cleanup);

	it('uses concise accessible names when mode options are unavailable', () => {
		render(ComposerBottomBar, {
			canAttachImages: false,
			attachImagesTooltip: 'Unavailable',
			onAddImage: vi.fn(),
			permissionOptions: [],
			selectedPermission: 'default',
			onPermissionSelect: vi.fn(),
			thinkingOptions: [],
			selectedThinking: 'none',
			onThinkingSelect: vi.fn(),
			canSend: false,
			onSend: vi.fn(),
			sendTitle: 'Send',
			sendButtonClass: '',
			showAddMenu: false,
			showSendButton: false,
		});

		expect(screen.getByRole('button', { name: 'Permission mode' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Thinking effort' })).toBeTruthy();
	});
});
