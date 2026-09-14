import { describe, expect, it } from 'vitest';
import {
	assignGlobalShortcut,
	GLOBAL_SHORTCUT_IDS,
	globalShortcutContextsOverlap,
	formatGlobalShortcut,
	getDefaultGlobalShortcut,
	getEffectiveGlobalShortcut,
	globalShortcutBindingFromEvent,
	globalShortcutBindingsConflict,
	globalShortcutMatchesEvent,
	resetGlobalShortcut,
	sanitizeGlobalShortcutOverrides,
} from '../global-shortcuts';

describe('global shortcuts', () => {
	it.each([false, true])(
		'has nonconflicting defaults in overlapping contexts (Mac: %s)',
		(isMac) => {
			for (const [index, first] of GLOBAL_SHORTCUT_IDS.entries()) {
				for (const second of GLOBAL_SHORTCUT_IDS.slice(index + 1)) {
					if (!globalShortcutContextsOverlap(first, second)) continue;
					expect(
						globalShortcutBindingsConflict(
							getDefaultGlobalShortcut(first, isMac)!,
							getDefaultGlobalShortcut(second, isMac)!,
						),
						`${first} / ${second}`,
					).toBe(false);
				}
			}
		},
	);

	it.each(['file-save', 'open-sidebar-search'] as const)(
		'resets %s without disabling another context',
		(id) => {
			expect(resetGlobalShortcut({ [id]: null }, id)).toEqual({ overrides: {}, unassignedIds: [] });
			expect(sanitizeGlobalShortcutOverrides({ [id]: { key: 's', ctrl: true } })).toEqual({
				[id]: { key: 's', ctrl: true },
			});
		},
	);

	it('reports all conflicting contexts when assigning a workspace shortcut', () => {
		const result = assignGlobalShortcut({}, 'new-chat', { key: 's', primary: true });
		expect(result.unassignedIds).toEqual(['open-sidebar-search', 'file-save']);
		expect(result.overrides['open-sidebar-search']).toBeNull();
		expect(result.overrides['file-save']).toBeNull();
	});

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
		expect(getDefaultGlobalShortcut('file-save')).toEqual({ key: 's', primary: true });
		expect(getEffectiveGlobalShortcut('file-save', {})).toEqual({ key: 's', primary: true });
		expect(getEffectiveGlobalShortcut('editor-find', {})).toEqual({ key: 'f', primary: true });
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

	it('uses nonconflicting macOS file-history bindings', () => {
		expect(getDefaultGlobalShortcut('file-navigate-back', true)).toEqual({ key: '-', ctrl: true });
		expect(getDefaultGlobalShortcut('file-navigate-forward', true)).toEqual({
			key: '-',
			ctrl: true,
			shift: true,
		});
	});

	it('matches shifted punctuation by its physical base key', () => {
		const event = new KeyboardEvent('keydown', {
			key: '|',
			code: 'Backslash',
			ctrlKey: true,
			shiftKey: true,
		});
		expect(globalShortcutBindingFromEvent(event)).toEqual({
			key: '\\',
			ctrl: true,
			shift: true,
		});
		expect(globalShortcutMatchesEvent({ key: '\\', primary: true, shift: true }, event)).toBe(true);
	});

	it('treats primary bindings as conflicts with explicit Ctrl and Cmd forms', () => {
		expect(
			globalShortcutBindingsConflict({ key: 'p', primary: true }, { key: 'p', ctrl: true }),
		).toBe(true);
		expect(
			globalShortcutBindingsConflict({ key: 'p', primary: true }, { key: 'p', meta: true }),
		).toBe(true);
	});

	it('normalizes shifted digits to their physical base keys', () => {
		const event = new KeyboardEvent('keydown', {
			key: '!',
			code: 'Digit1',
			ctrlKey: true,
			shiftKey: true,
		});
		expect(globalShortcutBindingFromEvent(event)).toEqual({
			key: '1',
			ctrl: true,
			shift: true,
		});
		expect(globalShortcutMatchesEvent({ key: '1', ctrl: true, shift: true }, event)).toBe(true);
	});

	it('migrates persisted shifted-symbol overrides to their physical base keys', () => {
		const overrides = sanitizeGlobalShortcutOverrides({
			'new-chat': { key: '!', ctrl: true, shift: true },
		});
		const binding = overrides['new-chat'];
		const event = new KeyboardEvent('keydown', {
			key: '!',
			code: 'Digit1',
			ctrlKey: true,
			shiftKey: true,
		});

		expect(binding).toEqual({ key: '1', ctrl: true, shift: true });
		expect(binding && globalShortcutMatchesEvent(binding, event)).toBe(true);
	});

	it('auto-unassigns the previous command when assigning a duplicate', () => {
		const result = assignGlobalShortcut({}, 'new-chat', { key: 'd', ctrl: true });

		expect(result.unassignedIds).toEqual(['scroll-half-page-down']);
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

		expect(result.unassignedIds).toEqual(['new-chat']);
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

	it('preserves custom chords that conflict with macOS-specific defaults', () => {
		expect(
			sanitizeGlobalShortcutOverrides(
				{
					'new-chat': { key: '-', ctrl: true },
				},
				true,
			),
		).toEqual({
			'new-chat': { key: '-', ctrl: true },
			'file-navigate-back': null,
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
