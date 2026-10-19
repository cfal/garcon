// Display policy functions for tool rendering. Encapsulates the
// decision logic that determines visibility and rule resolution
// independently of the registry data.

import type { ToolPayload, ToolDisplayRule, ToolResultDisplayRule } from '$lib/chat/tools/tool-display-contract.js';
import type { ToolUseChatMessage } from '$shared/chat-types';
import { extractContentString } from '$lib/chat/tools/tool-display-presenters.js';
import * as m from '$lib/paraglide/messages.js';

const FAILED_RESULT_RULE: ToolResultDisplayRule = {
	mode: 'collapsible',
	title: () => m.chat_message_error(),
	defaultOpen: false,
	contentKind: 'text',
	getContentProps: (result) => {
		const content = result.content as { items?: unknown } | undefined;
		const text = Array.isArray(content?.items)
			? content.items.flatMap((item) => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []).join('\n')
			: '';
		return { content: text || extractContentString(result.content), format: 'plain' };
	},
};

export function resolveToolResultDisplayRule(
	rule: ToolDisplayRule,
	toolResult: ToolPayload | null | undefined,
	tool?: ToolUseChatMessage,
): ToolResultDisplayRule | undefined {
	const emptyRequiredInput = tool?.type === 'bash-tool-use'
		? tool.command === ''
		: tool?.type === 'exec-tool-use'
			? tool.code === ''
			: (tool?.type === 'read-tool-use' || tool?.type === 'write-tool-use' || tool?.type === 'edit-tool-use') && tool.filePath === '';
	if (toolResult?.isError === true && emptyRequiredInput) return FAILED_RESULT_RULE;
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
