// Shared constants for permission modes, thinking modes, and related
// UI labels. Consolidates duplicated definitions from agent-state
// and new-chat-form-state into a single source of truth.

import type { AmpAgentMode, PermissionMode, ThinkingMode } from '$lib/types/chat';

export interface ThinkingModeOption {
	id: ThinkingMode;
	name: string;
	description?: string;
	prefix?: string;
	color?: string;
}

export const THINKING_MODES: ThinkingModeOption[] = [
	{
		id: 'none',
		name: 'Standard',
		description: 'Regular Claude response',
		prefix: '',
		color: 'text-muted-foreground',
	},
	{
		id: 'think',
		name: 'Think',
		description: 'Basic extended thinking',
		prefix: 'think',
		color: 'text-foreground',
	},
	{
		id: 'think-hard',
		name: 'Think Hard',
		description: 'More thorough evaluation',
		prefix: 'think hard',
		color: 'text-foreground',
	},
	{
		id: 'think-harder',
		name: 'Think Harder',
		description: 'Deep analysis with alternatives',
		prefix: 'think harder',
		color: 'text-foreground',
	},
	{
		id: 'ultrathink',
		name: 'Ultrathink',
		description: 'Maximum thinking budget',
		prefix: 'ultrathink',
		color: 'text-foreground',
	},
];

export const CLAUDE_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
	'bypassPermissions',
	'plan',
];

export const NON_CLAUDE_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
	'bypassPermissions',
];

export const CYCLABLE_PERMISSION_MODES: PermissionMode[] = [
	'default',
	'acceptEdits',
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
	bypassPermissions: 'Bypass Permissions',
	plan: 'Plan Mode',
};
