import { toolSummaryCategory, toolSummaryWeight, type SummaryCategory } from '$shared/transcript-display-policy.js';
import { isToolUseMessage } from '$shared/chat-types';
import type { ConversationFeedMessageRenderItem } from '$lib/chat/transcript/conversation-feed-items.js';
import * as m from '$lib/paraglide/messages.js';
import { getLocale } from '$lib/paraglide/runtime.js';

export interface ToolUseSummary {
	count: number;
	label: string;
}

function categoryClause(category: SummaryCategory, count: number): string {
	switch (category) {
		case 'commands':
			return m.chat_tool_group_commands({ count });
		case 'fileReads':
			return m.chat_tool_group_file_reads({ count });
		case 'fileEdits':
			return m.chat_tool_group_file_edits({ count });
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
	const counts: Record<SummaryCategory, number> = {
		commands: 0,
		fileReads: 0,
		fileEdits: 0,
		other: 0,
	};
	const categoryOrder: SummaryCategory[] = [];
	for (const { message } of members) {
		if (!isToolUseMessage(message)) continue;
		const category = toolSummaryCategory(message.type);
		if (counts[category] === 0) categoryOrder.push(category);
		counts[category] += toolSummaryWeight(message);
	}
	return summarizeToolCounts(members.length, counts, categoryOrder);
}

export function summarizeToolCounts(count: number, counts: Readonly<Record<SummaryCategory, number>>, categoryOrder: readonly SummaryCategory[]): ToolUseSummary {
	const clauses = categoryOrder.flatMap((category) => {
		const count = counts[category];
		return count > 0 ? [categoryClause(category, count)] : [];
	});
	return {
		count,
		label: formatSentence(clauses),
	};
}
