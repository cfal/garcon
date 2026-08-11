import { describe, expect, it } from 'vitest';
import { COMPOSER_SHORTCUTS, GLOBAL_SHORTCUTS, SLASH_COMMANDS } from '../keyboard-shortcut-entries';
import { formatGlobalShortcut, getEffectiveGlobalShortcut } from '$lib/workspace/global-shortcuts';

describe('keyboard shortcut entries', () => {
	it('documents pane-tab and chat-list navigation without changing New Chat', () => {
		const shortcutKeys = new Map(
			GLOBAL_SHORTCUTS.map((entry) => {
				const binding = getEffectiveGlobalShortcut(entry.id, {});
				return [entry.label(), binding ? formatGlobalShortcut(binding) : []];
			}),
		);

		expect(shortcutKeys.get('Go to tab on the left')).toEqual(['Ctrl', 'Shift', 'J']);
		expect(shortcutKeys.get('Go to tab on the right')).toEqual(['Ctrl', 'Shift', 'L']);
		expect(shortcutKeys.get('Go to chat above')).toEqual(['Ctrl', 'Shift', 'P']);
		expect(shortcutKeys.get('Go to chat below')).toEqual(['Ctrl', 'Shift', 'N']);
		expect(shortcutKeys.get('Toggle focus between main view and workspace sidebar')).toEqual([
			'Ctrl',
			'Shift',
			'O',
		]);
		expect(shortcutKeys.get('New chat')).toEqual(['Ctrl', 'N']);
		expect(shortcutKeys.get('Delete selected chat')).toEqual(['Ctrl', 'Shift', 'D']);
		expect(shortcutKeys.get('Scroll up half a page')).toEqual(['Ctrl', 'U']);
		expect(shortcutKeys.get('Scroll down half a page')).toEqual(['Ctrl', 'D']);
	});

	it('documents the schedule-in command syntax', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([expect.objectContaining({ command: '/in <duration> <prompt>' })]),
		);
	});

	it('keeps the expanded composer opener with composer shortcuts', () => {
		const entry = COMPOSER_SHORTCUTS.find((candidate) => candidate.id === 'open-composer-editor');
		const binding = entry ? getEffectiveGlobalShortcut(entry.id, {}) : null;

		expect(entry?.label()).toBe('Open expanded composer');
		expect(binding ? formatGlobalShortcut(binding) : []).toEqual(['Ctrl', 'Shift', 'E']);
		expect(GLOBAL_SHORTCUTS.some((candidate) => candidate.id === entry?.id)).toBe(false);
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

	it('documents persisted boundary moves and tag mutations', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ command: '/move <top|bottom>' }),
				expect.objectContaining({ command: '/tag <add|rm> <tag> [tag...]' }),
			]),
		);
	});

	it('documents both steer command spellings', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ command: '/steer <prompt>' }),
				expect.objectContaining({ command: '/st <prompt>' }),
			]),
		);
	});

	it('documents both snippet command spellings', () => {
		expect(SLASH_COMMANDS).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ command: '/snippet <short-name> [arguments]' }),
				expect.objectContaining({ command: '/s <short-name> [arguments]' }),
			]),
		);
	});
});
