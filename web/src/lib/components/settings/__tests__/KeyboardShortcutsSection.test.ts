import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { ChatInteractionGate } from '$lib/workspace/chat-interaction-gate.svelte';
import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
import KeyboardShortcutsSectionTestHost from './KeyboardShortcutsSectionTestHost.svelte';

describe('KeyboardShortcutsSection', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('auto-unassigns the previous command and reports the reassignment', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const newChat = screen.getByRole('group', { name: 'New chat' });
		const changeNewChat = within(newChat).getByRole('button', {
			name: 'Change shortcut for New chat',
		});

		await fireEvent.click(changeNewChat);
		await fireEvent.keyDown(changeNewChat, { key: 'd', ctrlKey: true });

		expect(screen.getByRole('status').textContent).toContain(
			'Ctrl+D was removed from Scroll down half a page',
		);
		expect(
			within(screen.getByRole('group', { name: 'Scroll down half a page' })).getByText(
				'Unassigned',
			),
		).toBeTruthy();
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}').globalShortcuts,
		).toMatchObject({
			'new-chat': { key: 'd', ctrl: true },
			'scroll-half-page-down': null,
		});
	});

	it('cancels recording on Escape without letting the dialog underneath close', async () => {
		const transients = new TransientLayerRegistry(new ChatInteractionGate());
		render(KeyboardShortcutsSectionTestHost, { transients });
		const newChat = screen.getByRole('group', { name: 'New chat' });
		const changeNewChat = within(newChat).getByRole('button', {
			name: 'Change shortcut for New chat',
		});

		await fireEvent.click(changeNewChat);
		expect(within(newChat).getByText('Press shortcut')).toBeTruthy();

		const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		expect(transients.handleEscape(escape)).toBe(true);
		await tick();

		expect(within(newChat).queryByText('Press shortcut')).toBeNull();
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings)).toBeNull();
	});

	it('abandons recording when the control loses focus', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const newChat = screen.getByRole('group', { name: 'New chat' });
		const changeNewChat = within(newChat).getByRole('button', {
			name: 'Change shortcut for New chat',
		});

		await fireEvent.click(changeNewChat);
		await fireEvent.blur(changeNewChat);

		expect(within(newChat).queryByText('Press shortcut')).toBeNull();
		await fireEvent.keyDown(changeNewChat, { key: 'x', ctrlKey: true });
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings)).toBeNull();
	});

	it('removes and resets a system shortcut', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const deleteChat = screen.getByRole('group', { name: 'Delete selected chat' });

		await fireEvent.click(within(deleteChat).getByRole('button', { name: 'Remove' }));
		expect(within(deleteChat).getByText('Unassigned')).toBeTruthy();

		await fireEvent.click(within(deleteChat).getByRole('button', { name: 'Reset' }));
		expect(within(deleteChat).getByText('System default')).toBeTruthy();
		expect(
			within(deleteChat).getByRole('button', {
				name: 'Change shortcut for Delete selected chat',
			}).textContent,
		).toContain('Ctrl');
	});
});
