import * as m from '$lib/paraglide/messages.js';
import {
	TYPOGRAPHY_SURFACES,
	type FontSizePreference,
	type TypographySurface,
} from '$lib/theme/typography.js';
import type { FontPreference } from '$lib/theme/fonts.js';

export const TYPOGRAPHY_SURFACE_LABELS: Record<TypographySurface, () => string> = {
	interface: m.settings_typography_interface,
	'chat-list': m.settings_typography_chat_list,
	'chat-feed': m.settings_typography_chat_feed,
	'chat-code': m.settings_typography_chat_code,
	'chat-output': m.settings_typography_chat_output,
	'code-editor': m.settings_typography_code_editor,
	'expanded-editor': m.settings_typography_expanded_editor,
	'code-diff': m.settings_typography_code_diff,
	terminal: m.settings_typography_terminal,
};

export function fontControlLabel(surface: TypographySurface): string {
	return `${TYPOGRAPHY_SURFACE_LABELS[surface]()} ${m.settings_font()}`;
}

export function fontSizeControlLabel(surface: TypographySurface): string {
	return `${TYPOGRAPHY_SURFACE_LABELS[surface]()} ${m.settings_font_size()}`;
}

export function typographySizeLabel(surface: TypographySurface, size: FontSizePreference): string {
	const { defaultSize } = TYPOGRAPHY_SURFACES.find(({ id }) => id === surface)!;
	if (surface === 'interface' || surface === 'chat-list')
		return m.settings_font_base_value({ size: size === 'default' ? defaultSize : size });
	if (size !== 'default') return `${size}px`;
	if (surface === 'chat-code') return '11/12px';
	if (surface === 'code-diff') return '11-13px';
	return `${defaultSize}px`;
}

export function fontSizeLabel(size: FontSizePreference, surface: TypographySurface): string {
	const label = typographySizeLabel(surface, size);
	return size === 'default' ? `${label} (${m.settings_appearance_default()})` : label;
}

export function fontLabel(surface: TypographySurface, font: FontPreference): string {
	switch (font) {
		case 'system-sans':
			return m.settings_font_system_sans();
		case 'system-serif':
			return m.settings_font_system_serif();
		case 'system-mono':
			return m.settings_font_system_mono();
		case 'departure-mono':
			return m.settings_font_departure_mono();
		case 'jetbrains-mono':
			return 'JetBrains Mono';
		case 'inter':
			return 'Inter';
		case 'default':
			switch (surface) {
				case 'code-editor':
				case 'expanded-editor':
					return m.settings_font_system_editor();
				case 'chat-code':
				case 'code-diff':
					return m.settings_font_system_mono();
				case 'terminal':
					return 'Monaspace Neon NF';
				default:
					return m.settings_font_system_sans();
			}
	}
}
