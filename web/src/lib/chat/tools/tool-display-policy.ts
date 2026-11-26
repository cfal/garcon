// Display policy functions for tool rendering. Encapsulates the
// decision logic that determines visibility and rule resolution
// independently of the registry data.

import type { ToolPayload, ToolDisplayRule, ToolResultDisplayRule } from '$lib/chat/tools/tool-display-contract.js';
import type { ToolUseChatMessage } from '$shared/chat-types';
import { reportedResultProps } from '$lib/chat/tools/tool-display-presenters.js';
import * as m from '$lib/paraglide/messages.js';

const TEXT_RESULT_RULE: ToolResultDisplayRule = {
	mode: 'collapsible',
	defaultOpen: false,
	contentKind: 'text',
	getContentProps: reportedResultProps,
};

const FAILED_RESULT_RULE: ToolResultDisplayRule = { ...TEXT_RESULT_RULE, title: () => m.chat_message_error() };

function hasEmptyRequiredInput(tool: ToolUseChatMessage | undefined): boolean {
	switch (tool?.type) {
		case 'bash-tool-use':
			return tool.command === '';
		case 'claude-tool-search-tool-use':
			return tool.query === '';
		case 'claude-monitor-tool-use':
			return tool.description === '';
		case 'exec-tool-use':
			return tool.code === '';
		case 'read-tool-use':
		case 'write-tool-use':
		case 'edit-tool-use':
			return tool.filePath === '';
		default:
			return false;
	}
}

export function resolveToolResultDisplayRule(
	rule: ToolDisplayRule,
	toolResult: ToolPayload | null | undefined,
	tool?: ToolUseChatMessage,
): ToolResultDisplayRule | undefined {
	if (!toolResult) return rule.result;
	if (toolResult.isError === true) {
		if (!rule.result?.reportsStatus) return hasEmptyRequiredInput(tool) ? FAILED_RESULT_RULE : rule.result;
		const status = (toolResult.content as { status?: unknown } | undefined)?.status;
		return typeof status === 'string' && status
			? { ...FAILED_RESULT_RULE, title: `${m.chat_message_error()}: ${status}` }
			: FAILED_RESULT_RULE;
	}
	if (rule.result?.mode === 'collapsible') {
		const content = toolResult.content as Record<string, unknown> | undefined;
		const keys = Object.keys(content ?? {});
		if (!keys.length || (keys.length === 1 && typeof content?.raw === 'string' && !/\S/.test(content.raw))) return undefined;
	}
	return rule.result;
}

export function shouldRenderToolResult(
	rule: ToolDisplayRule,
	toolResult: ToolPayload | null | undefined,
	tool?: ToolUseChatMessage,
): boolean {
	const result = resolveToolResultDisplayRule(rule, toolResult, tool);
	if (!result || result.hidden) return false;
	if (result.hideOnSuccess && toolResult && !toolResult.isError) return false;
	const mode = result.mode;
	return mode === 'inline' || mode === 'collapsible';
}

/** Resolves the display rule for a given tool type, falling back to default. */
export function resolveDisplayRule(
	registry: Record<string, ToolDisplayRule>,
	toolType: string,
): ToolDisplayRule {
	return registry[toolType] || registry.default;
}
