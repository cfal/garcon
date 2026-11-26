import * as m from '$lib/paraglide/messages.js';
import type { ToolDisplayRule } from './tool-display-contract.js';
import { extractContentString, truncate } from './tool-display-presenters.js';

function appendDetailLine(lines: string[], label: string, value: string | undefined): void {
	if (!value) return;
	lines.push(
		value.includes('\n') || value.startsWith('- ')
			? `**${label}:**\n${value}`
			: `**${label}:** ${value}`,
	);
}

function codexSubagentActionLabel(action: string): string {
	switch (action) {
		case 'spawn_agent':
			return 'Spawn agent';
		case 'send_input':
		case 'send_message':
			return 'Send message';
		case 'followup_task':
			return 'Follow-up task';
		case 'wait_agent':
			return 'Wait for agent';
		case 'interrupt_agent':
			return 'Interrupt agent';
		case 'list_agents':
			return 'List agents';
		case 'close_agent':
			return 'Close agent';
		case 'resume_agent':
			return 'Resume agent';
		case 'agent_status':
			return 'Agent status';
		default:
			return 'Subagent';
	}
}

function codexSubagentDetails(input: Record<string, unknown>): Record<string, unknown> {
	return input.details && typeof input.details === 'object' && !Array.isArray(input.details)
		? (input.details as Record<string, unknown>)
		: {};
}

function codexSubagentTitle(input: Record<string, unknown>): string {
	const action = String(input.action ?? '');
	const details = codexSubagentDetails(input);
	const label = codexSubagentActionLabel(action);
	const primary = String(details.taskName ?? details.message ?? details.target ?? '').trim();
	return primary ? `${label}: ${truncate(primary, 80)}` : label;
}

function codexSubagentItemsMarkdown(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const lines = value
		.map((item) => {
			if (!item || typeof item !== 'object') return '';
			const raw = item as Record<string, unknown>;
			return String(raw.text ?? raw.path ?? raw.name ?? raw.type ?? '').trim();
		})
		.filter(Boolean)
		.map((item) => `- ${item}`);
	return lines.length > 0 ? lines.join('\n') : undefined;
}

function codexSubagentStatesMarkdown(value: unknown): string | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const lines = Object.entries(value as Record<string, unknown>)
		.map(([target, value]) => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
			const agentState = value as Record<string, unknown>;
			const status = String(agentState.status ?? '').trim();
			const message = String(agentState.message ?? '').trim();
			return status ? `- ${target}: ${status}${message ? ` — ${message}` : ''}` : '';
		})
		.filter(Boolean);
	return lines.length > 0 ? lines.join('\n') : undefined;
}

function codexSubagentMarkdown(input: Record<string, unknown>): string {
	const action = String(input.action ?? '');
	const details = codexSubagentDetails(input);
	const lines: string[] = [];
	appendDetailLine(lines, 'Action', codexSubagentActionLabel(action));
	appendDetailLine(lines, 'Task', details.taskName as string | undefined);
	appendDetailLine(lines, 'Target', details.target as string | undefined);
	appendDetailLine(
		lines,
		'Targets',
		Array.isArray(details.targets) ? details.targets.filter(Boolean).join(', ') : undefined,
	);
	appendDetailLine(lines, 'Message', details.message as string | undefined);
	appendDetailLine(lines, 'Agent type', details.agentType as string | undefined);
	appendDetailLine(lines, 'Model', details.model as string | undefined);
	appendDetailLine(lines, 'Reasoning', details.reasoningEffort as string | undefined);
	appendDetailLine(lines, 'Service tier', details.serviceTier as string | undefined);
	appendDetailLine(lines, 'Fork turns', details.forkTurns as string | undefined);
	appendDetailLine(
		lines,
		'Timeout',
		typeof details.timeoutMs === 'number' ? `${details.timeoutMs} ms` : undefined,
	);
	appendDetailLine(lines, 'Path prefix', details.pathPrefix as string | undefined);
	appendDetailLine(lines, 'Items', codexSubagentItemsMarkdown(details.items));
	appendDetailLine(lines, 'States', codexSubagentStatesMarkdown(details.agentStates));
	return lines.join('\n\n');
}

export const CODEX_TOOL_DISPLAY_RULES = {
	'codex-subagent-tool-use': {
		input: {
			mode: 'collapsible',
			label: 'Subagent',
			title: codexSubagentTitle,
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (input) => ({
				content: codexSubagentMarkdown(input),
			}),
			colorScheme: {
				border: 'border-status-info-border',
			},
		},
		result: {
			mode: 'collapsible',
			title: 'Subagent result',
			defaultOpen: true,
			contentKind: 'markdown',
			getContentProps: (result) => ({
				content: extractContentString(result?.content) || m.chat_tool_no_response(),
			}),
		},
	},
} satisfies Record<string, ToolDisplayRule>;
