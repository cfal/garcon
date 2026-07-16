// Display catalog for the Shortcuts settings tab. Entries mirror the handlers
// in workspace/workspace-shortcuts.ts and the composer slash commands. Changes
// to shortcuts or built-in commands also update this catalog.

import * as m from '$lib/paraglide/messages.js';

export interface ShortcutEntry {
	label: () => string;
	keys: string[];
}

export interface SlashCommandEntry {
	command: string;
	description: () => string;
}

export const GLOBAL_SHORTCUTS: readonly ShortcutEntry[] = [
	{ label: m.settings_shortcut_toggle_command_palette, keys: ['Ctrl/Cmd', 'P'] },
	{ label: m.settings_shortcut_open_sidebar_search, keys: ['Ctrl/Cmd', 'S'] },
	{ label: m.settings_shortcut_new_chat, keys: ['Ctrl', 'N'] },
	{ label: m.settings_shortcut_rename_chat, keys: ['Ctrl', 'R'] },
	{ label: m.settings_shortcut_delete_chat, keys: ['Ctrl', 'D'] },
	{ label: m.settings_shortcut_navigate_tab_left, keys: ['Ctrl', 'Shift', 'J'] },
	{ label: m.settings_shortcut_navigate_tab_right, keys: ['Ctrl', 'Shift', 'L'] },
	{ label: m.settings_shortcut_navigate_chat_above, keys: ['Ctrl', 'Shift', 'P'] },
	{ label: m.settings_shortcut_navigate_chat_below, keys: ['Ctrl', 'Shift', 'N'] },
	{ label: m.settings_shortcut_toggle_main_sidebar_focus, keys: ['Ctrl', 'Shift', 'O'] },
	{ label: m.settings_shortcut_open_settings, keys: ['Ctrl', ','] },
];

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
	{ command: '/compact', description: m.settings_slash_command_compact },
	{ command: '/fork [<prompt>]', description: m.settings_slash_command_fork },
	{ command: '/goal', description: m.settings_slash_command_goal },
	{ command: '/in <duration> <prompt>', description: m.settings_slash_command_in },
	{ command: '/rename <title>', description: m.settings_slash_command_rename },
	{
		command: '/snippets <short-name> [arguments]',
		description: m.settings_slash_command_snippets,
	},
	{
		command: '/s <short-name> [arguments]',
		description: m.settings_slash_command_snippets_short,
	},
];
