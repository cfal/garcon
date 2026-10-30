import * as m from '$lib/paraglide/messages.js';
import {
	fontControlLabel,
	fontSizeControlLabel,
} from '$lib/components/shared/typography-labels.js';
import { TYPOGRAPHY_SURFACES } from '$lib/theme/typography.js';
import { CONFIGURABLE_SHORTCUTS, SLASH_COMMANDS } from './keyboard-shortcut-entries';
import type { SettingsTab } from '$lib/stores/app-shell.svelte';

export interface SettingsSearchEntry {
	readonly tab: SettingsTab;
	readonly label: string;
	readonly section: string;
}

// Uses the same translated copy as the settings controls, without indexing user values.
export function settingsSearchEntries(): SettingsSearchEntry[] {
	return [
		...[
			m.settings_tab_authentication(),
			m.auth_logout(),
			m.auth_change_username(),
			m.auth_change_password(),
		].map((label) => ({
			tab: 'authentication' as const,
			label,
			section: m.settings_tab_authentication(),
		})),
		...[
			m.settings_tab_appearance(),
			m.settings_theme_title(),
			m.settings_ui_style(),
			m.settings_typography(),
			m.settings_highlight_active_window(),
			m.settings_fullscreen_covers_sidebar(),
			m.settings_workspace_titlebar_size(),
			m.settings_chat_max_width(),
			m.settings_auto_hide_chat_scrollbar(),
			m.settings_inline_image_thumbnail_size(),
			m.settings_inline_mermaid_thumbnail_size(),
			m.settings_overlay_backdrop_effects(),
			m.settings_chat_reduce_motion(),
			m.settings_composer_status_bar(),
			m.settings_composer_status_bar_git_projects(),
			m.settings_composer_status_bar_non_git_projects(),
			m.settings_composer_status_bar_project_path(),
			m.settings_composer_status_bar_git_branch(),
			m.settings_composer_status_bar_commit(),
			...TYPOGRAPHY_SURFACES.flatMap(({ id }) => [fontControlLabel(id), fontSizeControlLabel(id)]),
		].map((label) => ({ tab: 'appearance' as const, label, section: m.settings_tab_appearance() })),
		...[
			m.settings_tab_behavior(),
			m.settings_image_cache_size(),
			m.settings_sidebar_inactivity_duration(),
			m.settings_chat_auto_expand_tools(),
			m.settings_chat_combine_tool_use_messages(),
			m.settings_chat_always_expand_cli_messages(),
			m.settings_chat_show_thinking(),
			m.settings_chat_allow_direct_chats(),
			m.settings_chat_hidden_tools(),
			m.settings_chat_auto_scroll_to_bottom(),
			m.chat_composer_input_mode(),
			m.settings_snippet_trigger_label(),
			m.settings_text_editor_open_placement(),
			m.settings_image_viewer_open_placement(),
			m.settings_markdown_viewer_open_placement(),
			m.settings_file_recovery_title(),
			m.onboarding_setup_wizard_label(),
			m.settings_completion_sound_title(),
		].map((label) => ({ tab: 'behavior' as const, label, section: m.settings_tab_behavior() })),
		...[
			m.settings_tab_shortcuts(),
			m.settings_chat_send_by_shift_enter(),
			m.settings_shortcut_steer_with_ctrl_enter(),
			m.settings_shortcut_send_message(),
			m.settings_shortcuts_group_global(),
			m.settings_shortcuts_group_slash_commands(),
			...CONFIGURABLE_SHORTCUTS.map((entry) => entry.label()),
			...SLASH_COMMANDS.map((entry) => `${entry.command} ${entry.description()}`),
		].map((label) => ({ tab: 'shortcuts' as const, label, section: m.settings_tab_shortcuts() })),
		...[
			m.settings_tab_providers(),
			m.settings_key_setup_title(),
			m.settings_native_providers(),
			m.settings_custom_providers(),
			m.settings_api_providers_openai_title(),
			m.settings_api_providers_anthropic_title(),
		].map((label) => ({ tab: 'providers' as const, label, section: m.settings_tab_providers() })),
		...[m.settings_tab_other_agents()].map((label) => ({
			tab: 'other-agents' as const,
			label,
			section: m.settings_tab_other_agents(),
		})),
		...[
			m.settings_tab_general(),
			m.sidebar_chats_pinned_insert_position(),
			m.settings_hidden_bash_commands_title(),
			m.settings_transcript_search(),
			m.settings_enable_agent_commands(),
			m.settings_enable_chat_id_discovery(),
			m.settings_enable_send_message(),
			m.settings_enable_start_agent(),
			m.settings_enable_resume_agent(),
			m.settings_enable_schedule(),
			m.settings_enable_tickets(),
			m.settings_use_custom_app_title(),
		].map((label) => ({ tab: 'general' as const, label, section: m.settings_tab_general() })),
		...[
			m.settings_tab_automation(),
			m.settings_chat_generate_titles(),
			m.settings_chat_title_model(),
			m.settings_agent_switch_compaction_enabled(),
			m.settings_agent_switch_compaction_model(),
			m.settings_commit_message_model(),
			m.settings_prompt_refinement_model(),
			m.settings_ticket_chat_prompt(),
		].map((label) => ({ tab: 'automation' as const, label, section: m.settings_tab_automation() })),
		...[
			m.settings_tab_notifications(),
			m.browser_notifications_title(),
			m.browser_notifications_toggle(),
			m.settings_telegram_notifications(),
			m.settings_telegram_bot_token(),
		].map((label) => ({
			tab: 'notifications' as const,
			label,
			section: m.settings_tab_notifications(),
		})),
		...[
			m.settings_tab_github(),
			m.settings_gh_title(),
			m.pull_request_repositories(),
			m.pull_request_repository_connect(),
			m.pull_request_repository_column_auto_review(),
			m.pull_request_repository_recent_runs(),
		].map((label) => ({
			tab: 'github' as const,
			label,
			section: m.settings_tab_github(),
		})),
		...[m.settings_tab_executors()].map((label) => ({
			tab: 'executors' as const,
			label,
			section: m.settings_tab_executors(),
		})),
	];
}

export function searchSettings(
	entries: readonly SettingsSearchEntry[],
	query: string,
): SettingsSearchEntry[] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return [];
	return entries.filter((entry) => {
		const text = `${entry.label} ${entry.section}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
