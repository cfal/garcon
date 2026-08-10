import { describe, expect, it } from 'vitest';
import {
	assignGlobalShortcut,
	formatGlobalShortcut,
	getEffectiveGlobalShortcut,
	globalShortcutBindingsConflict,
	globalShortcutMatchesEvent,
	resetGlobalShortcut,
	sanitizeGlobalShortcutOverrides,
} from '../global-shortcuts';

describe('global shortcuts', () => {
	it('uses defaults until a command is customized or disabled', () => {
		expect(getEffectiveGlobalShortcut('delete-chat', {})).toEqual({
			key: 'd',
			ctrl: true,
			shift: true,
		});
		expect(getEffectiveGlobalShortcut('scroll-half-page-up', {})).toEqual({
			key: 'u',
			ctrl: true,
		});
		expect(getEffectiveGlobalShortcut('scroll-half-page-down', {})).toEqual({
			key: 'd',
			ctrl: true,
		});
		expect(getEffectiveGlobalShortcut('open-composer-editor', {})).toEqual({
			key: 'e',
			ctrl: true,
			shift: true,
		});
		expect(
			getEffectiveGlobalShortcut('delete-chat', {
				'delete-chat': { key: 'x', ctrl: true },
			}),
		).toEqual({ key: 'x', ctrl: true });
		expect(getEffectiveGlobalShortcut('delete-chat', { 'delete-chat': null })).toBeNull();
	});

	it('matches primary bindings on Ctrl or Cmd without matching both together', () => {
		const binding = { key: 'p', primary: true };
		expect(
			globalShortcutMatchesEvent(
				binding,
				new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }),
			),
		).toBe(true);
		expect(
			globalShortcutMatchesEvent(
				binding,
				new KeyboardEvent('keydown', { key: 'p', metaKey: true }),
			),
		).toBe(true);
		expect(
			globalShortcutMatchesEvent(
				binding,
				new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, metaKey: true }),
			),
		).toBe(false);
	});

	it('treats primary bindings as conflicts with explicit Ctrl and Cmd forms', () => {
		expect(
			globalShortcutBindingsConflict({ key: 'p', primary: true }, { key: 'p', ctrl: true }),
		).toBe(true);
		expect(
			globalShortcutBindingsConflict({ key: 'p', primary: true }, { key: 'p', meta: true }),
		).toBe(true);
	});

	it('auto-unassigns the previous command when assigning a duplicate', () => {
		const result = assignGlobalShortcut({}, 'new-chat', { key: 'd', ctrl: true });

		expect(result.unassignedId).toBe('scroll-half-page-down');
		expect(result.overrides['scroll-half-page-down']).toBeNull();
		expect(result.overrides['new-chat']).toEqual({ key: 'd', ctrl: true });
	});

	it('auto-unassigns a custom conflict when restoring a system default', () => {
		const result = resetGlobalShortcut(
			{
				'new-chat': { key: 'd', ctrl: true, shift: true },
				'delete-chat': null,
			},
			'delete-chat',
		);

		expect(result.unassignedId).toBe('new-chat');
		expect(result.overrides['new-chat']).toBeNull();
		expect(Object.hasOwn(result.overrides, 'delete-chat')).toBe(false);
	});

	it('drops malformed persisted overrides', () => {
		expect(
			sanitizeGlobalShortcutOverrides({
				'delete-chat': { key: 'X', ctrl: true },
				'new-chat': { key: 'Control', ctrl: true },
				'rename-chat': { key: 'r' },
				unknown: { key: 'z', ctrl: true },
			}),
		).toEqual({
			'delete-chat': { key: 'x', ctrl: true },
		});
	});

	it('disables defaults that conflict with persisted custom bindings', () => {
		expect(
			sanitizeGlobalShortcutOverrides({
				'navigate-tab-left': { key: 'D', ctrl: true, shift: true },
				'rename-chat': { key: 'D', ctrl: true },
			}),
		).toEqual({
			'navigate-tab-left': { key: 'd', ctrl: true, shift: true },
			'rename-chat': { key: 'd', ctrl: true },
			'delete-chat': null,
			'scroll-half-page-down': null,
		});
	});

	it('preserves an older custom chord that conflicts with the editor default', () => {
		expect(
			sanitizeGlobalShortcutOverrides({
				'new-chat': { key: 'E', ctrl: true, shift: true },
			}),
		).toEqual({
			'new-chat': { key: 'e', ctrl: true, shift: true },
			'open-composer-editor': null,
		});
	});

	it('formats bindings as display keys', () => {
		expect(formatGlobalShortcut({ key: 'd', ctrl: true, shift: true })).toEqual([
			'Ctrl',
			'Shift',
			'D',
		]);
		expect(formatGlobalShortcut({ key: 'p', primary: true }, true)).toEqual(['Cmd', 'P']);
	});
});
