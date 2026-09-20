import { isToolUseMessage, type ToolUseChatMessage } from '$shared/chat-types';
import type { ConversationFeedMessageRenderItem } from '$lib/chat/transcript/conversation-feed-items.js';
import * as m from '$lib/paraglide/messages.js';
import { getLocale } from '$lib/paraglide/runtime.js';

export interface ToolUseSummary {
	count: number;
	label: string;
}

type ToolUseSummaryCategory = 'commands' | 'fileReads' | 'fileWrites' | 'other';

const CATEGORY_ORDER = [
	'commands',
	'fileReads',
	'fileWrites',
	'other',
] as const satisfies readonly ToolUseSummaryCategory[];

function summaryCategory(message: ToolUseChatMessage): ToolUseSummaryCategory {
	switch (message.type) {
		case 'bash-tool-use':
		case 'exec-tool-use':
			return 'commands';
		case 'read-tool-use':
		case 'list-tool-use':
		case 'grep-tool-use':
		case 'glob-tool-use':
			return 'fileReads';
		case 'edit-tool-use':
		case 'write-tool-use':
		case 'apply-patch-tool-use':
			return 'fileWrites';
		default:
			return 'other';
	}
}

function categoryClause(category: ToolUseSummaryCategory, count: number): string {
	switch (category) {
		case 'commands':
			return m.chat_tool_group_commands({ count });
		case 'fileReads':
			return m.chat_tool_group_file_reads({ count });
		case 'fileWrites':
			return m.chat_tool_group_file_writes({ count });
		case 'other':
			return m.chat_tool_group_other_actions({ count });
	}
}

function formatSentence(clauses: readonly string[]): string {
	const locale = getLocale();
	const actions = new Intl.ListFormat(locale, { style: 'long', type: 'unit' }).format(clauses);
	const [first, ...rest] = Array.from(actions);
	const sentence = first ? first.toLocaleUpperCase(locale) + rest.join('') : actions;
	return m.chat_tool_group_sentence({ actions: sentence });
}

export function summarizeToolUses(
	members: readonly ConversationFeedMessageRenderItem[],
): ToolUseSummary {
	const counts: Record<ToolUseSummaryCategory, number> = {
		commands: 0,
		fileReads: 0,
		fileWrites: 0,
		other: 0,
	};
	for (const { message } of members) {
		if (!isToolUseMessage(message)) continue;
		counts[summaryCategory(message)] += 1;
	}
	const clauses = CATEGORY_ORDER.flatMap((category) => {
		const count = counts[category];
		return count > 0 ? [categoryClause(category, count)] : [];
	});
	return {
		count: members.length,
		label: formatSentence(clauses),
	};
}
