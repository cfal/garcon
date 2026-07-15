import { describe, expect, it } from 'vitest';
import { GLOBAL_SHORTCUTS, SLASH_COMMANDS } from '../keyboard-shortcut-entries';

describe('keyboard shortcut entries', () => {
	it('documents pane-tab and chat-list navigation without changing New Chat', () => {
		const shortcutKeys = new Map(GLOBAL_SHORTCUTS.map((entry) => [entry.label(), entry.keys]));

		expect(shortcutKeys.get('Go to tab on the left')).toEqual(['Ctrl', 'Shift', 'J']);
		expect(shortcutKeys.get('Go to tab on the right')).toEqual(['Ctrl', 'Shift', 'L']);
		expect(shortcutKeys.get('Go to chat above')).toEqual(['Ctrl', 'Shift', 'P']);
		expect(shortcutKeys.get('Go to chat below')).toEqual(['Ctrl', 'Shift', 'N']);
		expect(shortcutKeys.get('Toggle focus between main view and right sidebar')).toEqual([
			'Ctrl',
			'Shift',
			'O',
		]);
		expect(shortcutKeys.get('New chat')).toEqual(['Ctrl', 'N']);
	});

	it('documents the schedule-in command syntax', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([expect.objectContaining({ command: '/in <duration> <prompt>' })]),
		);
	});

	it('documents the optional fork prompt argument', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([expect.objectContaining({ command: '/fork [<prompt>]' })]),
		);
	});

	it('documents the required rename title', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([expect.objectContaining({ command: '/rename <title>' })]),
		);
	});
});
