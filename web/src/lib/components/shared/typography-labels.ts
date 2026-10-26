import * as m from '$lib/paraglide/messages.js';
import type { FontSizePreference, TypographySurface } from '$lib/theme/typography.js';

export const TYPOGRAPHY_SURFACE_LABELS: Record<TypographySurface, () => string> = {
	interface: m.settings_typography_interface,
	'chat-list': m.settings_typography_chat_list,
	'chat-feed': m.settings_typography_chat_feed,
	'chat-code': m.settings_typography_chat_code,
	'code-editor': m.settings_typography_code_editor,
	'code-diff': m.settings_typography_code_diff,
	terminal: m.settings_typography_terminal,
};

export function fontControlLabel(surface: TypographySurface): string {
	return `${TYPOGRAPHY_SURFACE_LABELS[surface]()} ${m.settings_font()}`;
}

export function fontSizeControlLabel(surface: TypographySurface): string {
	return `${TYPOGRAPHY_SURFACE_LABELS[surface]()} ${m.settings_font_size()}`;
}

export function fontSizeLabel(size: FontSizePreference): string {
	return size === 'default' ? m.settings_appearance_default() : `${size}px`;
}
