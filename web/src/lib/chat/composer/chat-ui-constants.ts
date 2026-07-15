// Shared constants for permission modes, thinking modes, and related
// UI labels. Consolidates duplicated definitions from agent-state
// and new-chat-form-state into a single source of truth.

import type { AmpAgentMode, PermissionMode, ThinkingMode } from '$lib/types/chat';

export interface ThinkingModeOption {
	id: ThinkingMode;
	name: string;
	description?: string;
	color?: string;
}

export const THINKING_MODES: ThinkingModeOption[] = [
	{
		id: 'none',
		name: 'Default',
		description: 'Provider default effort',
		color: 'text-muted-foreground',
	},
	{
		id: 'low',
		name: 'Low',
		description: 'Light reasoning for quick tasks',
		color: 'text-foreground',
	},
	{
		id: 'medium',
		name: 'Medium',
		description: 'Balanced reasoning and speed',
		color: 'text-foreground',
	},
	{
		id: 'high',
		name: 'High',
		description: 'Thorough reasoning for harder tasks',
		color: 'text-foreground',
	},
	{
		id: 'xhigh',
		name: 'X-High',
		description: 'Deep reasoning for complex agentic work',
		color: 'text-foreground',
	},
	{
		id: 'max',
		name: 'Max',
		description: 'Maximum reasoning depth',
		color: 'text-foreground',
	},
	{
		id: 'ultra',
		name: 'Ultra',
		description: 'Highest Codex reasoning effort',
		color: 'text-foreground',
	},
];

export const CLAUDE_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
	'manualBypass',
	'bypassPermissions',
	'plan',
];

export const NON_CLAUDE_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
	'manualBypass',
	'bypassPermissions',
];

export const CYCLABLE_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
	'manualBypass',
	'bypassPermissions',
];

export interface AmpAgentModeOption {
	id: AmpAgentMode;
	name: string;
	description: string;
}

export const AMP_AGENT_MODES: AmpAgentModeOption[] = [
	{ id: 'smart', name: 'Smart', description: 'State-of-the-art models for maximum capability.' },
	{ id: 'deep', name: 'Deep', description: 'Extended reasoning for complex problems.' },
];

export const MODE_LABELS: Record<PermissionMode, string> = {
	default: 'Default',
	acceptEdits: 'Accept Edits',
	manualBypass: 'Manual Bypass',
	bypassPermissions: 'Bypass Permissions',
	plan: 'Plan Mode',
};
