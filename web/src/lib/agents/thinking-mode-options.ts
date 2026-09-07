import { THINKING_MODE_VALUES, type ThinkingMode } from '$shared/chat-modes';
import * as m from '$lib/paraglide/messages.js';

export interface ThinkingModeOption {
	id: ThinkingMode;
	label: string;
	description: string;
}

const presentation = {
	none: {
		label: m.thinking_mode_default_label,
		description: m.thinking_mode_default_description,
	},
	low: {
		label: m.thinking_mode_low_label,
		description: m.thinking_mode_low_description,
	},
	medium: {
		label: m.thinking_mode_medium_label,
		description: m.thinking_mode_medium_description,
	},
	high: {
		label: m.thinking_mode_high_label,
		description: m.thinking_mode_high_description,
	},
	xhigh: {
		label: m.thinking_mode_xhigh_label,
		description: m.thinking_mode_xhigh_description,
	},
	max: {
		label: m.thinking_mode_max_label,
		description: m.thinking_mode_max_description,
	},
	ultra: {
		label: m.thinking_mode_ultra_label,
		description: m.thinking_mode_ultra_description,
	},
} satisfies Record<ThinkingMode, { label: () => string; description: () => string }>;

export function buildThinkingModeOptions(): ThinkingModeOption[] {
	return THINKING_MODE_VALUES.map((id) => ({
		id,
		label: presentation[id].label(),
		description: presentation[id].description(),
	}));
}
