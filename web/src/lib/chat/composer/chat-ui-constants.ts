import type { ThinkingMode } from '$lib/types/chat';

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
