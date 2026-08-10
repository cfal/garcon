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

	it('renders composer preferences before editable shortcuts and persists both switches', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const shiftEnter = screen.getByRole('switch', { name: 'Send by Shift+Enter' });
		const ctrlEnter = screen.getByRole('switch', { name: 'Steer with Ctrl+Enter' });
		const firstEditableShortcut = screen.getByRole('group', { name: 'Open expanded composer' });

		expect(shiftEnter.getAttribute('aria-checked')).toBe('false');
		expect(ctrlEnter.getAttribute('aria-checked')).toBe('true');
		expect(
			ctrlEnter.compareDocumentPosition(firstEditableShortcut) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		await fireEvent.click(shiftEnter);
		await fireEvent.click(ctrlEnter);

		expect(shiftEnter.getAttribute('aria-checked')).toBe('true');
		expect(ctrlEnter.getAttribute('aria-checked')).toBe('false');
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}'),
		).toMatchObject({ sendByShiftEnter: true, steerWithCtrlEnter: false });
	});

	it('renders and edits the expanded composer opener in the Composer group', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const opener = screen.getByRole('group', { name: 'Open expanded composer' });
		const change = within(opener).getByRole('button', {
			name: 'Change shortcut for Open expanded composer',
		});

		expect(change.textContent).toContain('Ctrl');
		expect(change.textContent).toContain('Shift');
		expect(change.textContent).toContain('E');
		await fireEvent.click(change);
		await fireEvent.keyDown(change, { key: 'x', ctrlKey: true, shiftKey: true });

		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}').globalShortcuts,
		).toMatchObject({
			'open-composer-editor': { key: 'x', ctrl: true, shift: true },
		});
	});

	it('shows composer shortcut conflicts as shared feedback outside the Global group', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const opener = screen.getByRole('group', { name: 'Open expanded composer' });
		const change = within(opener).getByRole('button', {
			name: 'Change shortcut for Open expanded composer',
		});

		await fireEvent.click(change);
		await fireEvent.keyDown(change, { key: 'd', ctrlKey: true });

		const status = screen.getByRole('status');
		expect(status.textContent).toContain('Ctrl+D was removed from Scroll down half a page');
		expect(status.closest('section')).toBeNull();
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
