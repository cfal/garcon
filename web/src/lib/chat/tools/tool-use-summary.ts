import { isToolUseMessage, type ToolUseChatMessage } from '$shared/chat-types';
import type { ConversationFeedMessageRenderItem } from '$lib/chat/transcript/conversation-feed-items.js';
import { getToolDisplayLabel } from './tool-display-registry.js';
import * as m from '$lib/paraglide/messages.js';

export interface ToolUseSummary {
	count: number;
	visibleLabel: string;
	accessibleLabel: string;
}

function categoryLabel(message: ToolUseChatMessage): string {
	switch (message.type) {
		case 'exec-tool-use':
			return 'Exec';
		case 'unknown-tool-use':
			return 'Tool';
		case 'external-tool-use':
			return 'External tool';
		case 'mcp-tool-use':
			return 'MCP tool';
		default:
			return getToolDisplayLabel(message);
	}
}

export function summarizeToolUses(
	members: readonly ConversationFeedMessageRenderItem[],
): ToolUseSummary {
	const counts = new Map<string, number>();
	for (const { message } of members) {
		if (!isToolUseMessage(message)) continue;
		const label = categoryLabel(message);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	const categories = [...counts].map(([label, count]) =>
		m.chat_tool_group_category({ label, count }),
	);
	const total = m.chat_tool_group_total({ count: members.length });
	const visibleCategories = categories.slice(0, 3);
	if (categories.length > 3) {
		visibleCategories.push(
			m.chat_tool_group_more_categories({ count: categories.length - 3 }),
		);
	}
	return {
		count: members.length,
		visibleLabel: `${total}: ${visibleCategories.join(', ')}`,
		accessibleLabel: `${total}: ${categories.join(', ')}`,
	};
}
