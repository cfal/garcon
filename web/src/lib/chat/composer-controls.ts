import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import { THINKING_MODES } from '$lib/chat/chat-ui-constants';

export type ComposerModeIconId =
	| 'permission-default'
	| 'permission-accept-edits'
	| 'permission-bypass'
	| 'permission-plan'
	| 'thinking-none'
	| 'thinking-think'
	| 'thinking-think-hard'
	| 'thinking-think-harder'
	| 'thinking-ultrathink';

export interface ComposerMenuOption<T extends string = string> {
	value: T;
	label: string;
	description: string;
}

export interface ComposerModeOption<T extends string = string> extends ComposerMenuOption<T> {
	iconId: ComposerModeIconId;
	toneClass: string;
}

const PERMISSION_OPTION_METADATA: Record<
	PermissionMode,
	Omit<ComposerModeOption<PermissionMode>, 'value'>
> = {
	default: {
		label: 'Default',
		description: 'Asks before high-impact operations.',
		iconId: 'permission-default',
		toneClass:
			'bg-muted text-foreground border-border hover:bg-accent hover:text-accent-foreground',
	},
	acceptEdits: {
		label: 'Accept Edits',
		description: 'Allows safe file edits without interruption.',
		iconId: 'permission-accept-edits',
		toneClass: 'bg-secondary text-secondary-foreground border-border hover:bg-secondary/80',
	},
	// Warning tone is reserved for this unsafe state so the orange keeps its safety meaning.
	bypassPermissions: {
		label: 'Bypass Permissions',
		description: 'Runs without permission prompts.',
		iconId: 'permission-bypass',
		toneClass:
			'bg-status-warning text-status-warning-foreground border-status-warning-border hover:bg-status-warning/90',
	},
	plan: {
		label: 'Plan Mode',
		description: 'Focuses on planning before execution.',
		iconId: 'permission-plan',
		toneClass: 'bg-card text-card-foreground border-border hover:bg-muted',
	},
};

const THINKING_ICON_METADATA: Record<
	ThinkingMode,
	Pick<ComposerModeOption<ThinkingMode>, 'iconId' | 'toneClass'>
> = {
	none: {
		iconId: 'thinking-none',
		toneClass:
			'bg-muted text-foreground border-border hover:bg-accent hover:text-accent-foreground',
	},
	think: {
		iconId: 'thinking-think',
		toneClass:
			'bg-status-info text-status-info-foreground border-status-info-border hover:bg-status-info/90',
	},
	'think-hard': {
		iconId: 'thinking-think-hard',
		toneClass:
			'bg-status-success text-status-success-foreground border-status-success-border hover:bg-status-success/90',
	},
	// Reasoning effort is benign, so it escalates through neutral emphasis rather than the
	// warning/danger tones reserved for unsafe states like bypass permissions.
	'think-harder': {
		iconId: 'thinking-think-harder',
		toneClass: 'bg-accent text-accent-foreground border-border hover:bg-accent/80',
	},
	ultrathink: {
		iconId: 'thinking-ultrathink',
		toneClass:
			'bg-status-processing text-status-processing-foreground border-status-processing-border hover:bg-status-processing/90',
	},
};

export function buildPermissionOptions(
	modes: PermissionMode[],
): ComposerModeOption<PermissionMode>[] {
	return modes.map((mode) => ({
		value: mode,
		...PERMISSION_OPTION_METADATA[mode],
	}));
}

export function buildThinkingOptions(): ComposerModeOption<ThinkingMode>[] {
	return THINKING_MODES.map((mode) => {
		const iconMeta = THINKING_ICON_METADATA[mode.id] ?? THINKING_ICON_METADATA.none;
		return {
			value: mode.id,
			label: mode.name,
			description: mode.description || 'Default thinking behavior.',
			iconId: iconMeta.iconId,
			toneClass: iconMeta.toneClass,
		};
	});
}
