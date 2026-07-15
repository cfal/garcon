import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import { THINKING_MODES } from '$lib/chat/chat-ui-constants';

export type ComposerModeIconId =
	| 'permission-default'
	| 'permission-accept-edits'
	| 'permission-manual-bypass'
	| 'permission-bypass'
	| 'permission-plan'
	| 'thinking-none'
	| 'thinking-low'
	| 'thinking-medium'
	| 'thinking-high'
	| 'thinking-xhigh'
	| 'thinking-max'
	| 'thinking-ultra';

export interface ComposerMenuOption<T extends string = string> {
	value: T;
	label: string;
	description: string;
}

export interface ComposerModeOption<T extends string = string> extends ComposerMenuOption<T> {
	iconId: ComposerModeIconId;
	toneClass: string;
	rainbow?: boolean;
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
	manualBypass: {
		label: 'Manual Bypass',
		description: 'Starts normally and auto-approves permission prompts.',
		iconId: 'permission-manual-bypass',
		toneClass:
			'bg-status-info text-status-info-foreground border-status-info-border hover:bg-status-info/90',
	},
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
	low: {
		iconId: 'thinking-low',
		toneClass:
			'bg-status-info text-status-info-foreground border-status-info-border hover:bg-status-info/90',
	},
	medium: {
		iconId: 'thinking-medium',
		toneClass:
			'bg-status-success text-status-success-foreground border-status-success-border hover:bg-status-success/90',
	},
	high: {
		iconId: 'thinking-high',
		toneClass:
			'bg-status-warning text-status-warning-foreground border-status-warning-border hover:bg-status-warning/90',
	},
	xhigh: {
		iconId: 'thinking-xhigh',
		toneClass: 'bg-destructive/20 text-destructive border-destructive/40 hover:bg-destructive/30',
	},
	max: {
		iconId: 'thinking-max',
		toneClass: 'bg-destructive/30 text-destructive border-destructive/50 hover:bg-destructive/40',
	},
	ultra: {
		iconId: 'thinking-ultra',
		toneClass: 'bg-destructive/40 text-destructive border-destructive/60 hover:bg-destructive/50',
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

export function buildThinkingOptions(
	agentId?: string,
	model?: string,
): ComposerModeOption<ThinkingMode>[] {
	return THINKING_MODES.filter((mode) => mode.id !== 'ultra' || agentId === 'codex').map((mode) => {
		const iconMeta = THINKING_ICON_METADATA[mode.id] ?? THINKING_ICON_METADATA.none;
		const rainbow =
			mode.id === 'ultra' &&
			agentId === 'codex' &&
			(model === 'gpt-5.6-sol' || model?.endsWith(':gpt-5.6-sol'));
		return {
			value: mode.id,
			label: mode.name,
			description: mode.description || 'Default thinking behavior.',
			iconId: iconMeta.iconId,
			toneClass: rainbow ? 'rainbow-ultra-surface' : iconMeta.toneClass,
			...(rainbow ? { rainbow: true } : {}),
		};
	});
}
