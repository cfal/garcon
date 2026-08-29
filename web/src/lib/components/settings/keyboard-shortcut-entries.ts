// Display catalog for the Shortcuts settings tab. Entries mirror the handlers
// in workspace/workspace-shortcuts.ts and the composer slash commands. Changes
// to shortcuts or built-in commands also update this catalog.

import * as m from '$lib/paraglide/messages.js';
import type { GlobalShortcutId } from '$lib/workspace/global-shortcuts.js';

export interface ShortcutEntry {
	id: GlobalShortcutId;
	label: () => string;
}

export interface SlashCommandEntry {
	command: string;
	description: () => string;
}

export const COMPOSER_SHORTCUTS: readonly ShortcutEntry[] = [
	{ id: 'open-composer-editor', label: m.settings_shortcut_open_composer_editor },
];

export const GLOBAL_SHORTCUTS: readonly ShortcutEntry[] = [
	{ id: 'toggle-command-palette', label: m.settings_shortcut_toggle_command_palette },
	{ id: 'open-sidebar-search', label: m.settings_shortcut_open_sidebar_search },
	{ id: 'new-chat', label: m.settings_shortcut_new_chat },
	{ id: 'rename-chat', label: m.settings_shortcut_rename_chat },
	{ id: 'delete-chat', label: m.settings_shortcut_delete_chat },
	{ id: 'navigate-tab-left', label: m.settings_shortcut_navigate_tab_left },
	{ id: 'navigate-tab-right', label: m.settings_shortcut_navigate_tab_right },
	{ id: 'navigate-chat-above', label: m.settings_shortcut_navigate_chat_above },
	{ id: 'navigate-chat-below', label: m.settings_shortcut_navigate_chat_below },
	{
		id: 'cycle-window-focus',
		label: m.settings_shortcut_cycle_window_focus,
	},
	{ id: 'open-settings', label: m.settings_shortcut_open_settings },
	{ id: 'scroll-half-page-up', label: m.settings_shortcut_scroll_half_page_up },
	{ id: 'scroll-half-page-down', label: m.settings_shortcut_scroll_half_page_down },
];

export const CONFIGURABLE_SHORTCUTS: readonly ShortcutEntry[] = [
	...COMPOSER_SHORTCUTS,
	...GLOBAL_SHORTCUTS,
];

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
	{ command: '/compact', description: m.settings_slash_command_compact },
	{ command: '/fork [<prompt>]', description: m.settings_slash_command_fork },
	{ command: '/goal', description: m.settings_slash_command_goal },
	{ command: '/in <duration> <prompt>', description: m.settings_slash_command_in },
	{ command: '/rename <title>', description: m.settings_slash_command_rename },
	{ command: '/move <top|bottom>', description: m.settings_slash_command_move },
	{ command: '/tag <add|rm> <tag> [tag...]', description: m.settings_slash_command_tag },
	{ command: '/steer <prompt>', description: m.settings_slash_command_steer },
	{ command: '/st <prompt>', description: m.settings_slash_command_steer_short },
	{
		command: '/snippet <short-name> [arguments]',
		description: m.settings_slash_command_snippet,
	},
	{
		command: '/s <short-name> [arguments]',
		description: m.settings_slash_command_snippet_short,
	},
];
