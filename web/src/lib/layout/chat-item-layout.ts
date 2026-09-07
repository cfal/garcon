export const CHAT_ITEM_LAYOUTS = ['detailed', 'compact', 'single-line'] as const;

export type ChatItemLayout = (typeof CHAT_ITEM_LAYOUTS)[number];

export function parseChatItemLayout(value: unknown): ChatItemLayout | null {
	if (value === 'default') return 'detailed';
	return typeof value === 'string' && CHAT_ITEM_LAYOUTS.includes(value as ChatItemLayout)
		? (value as ChatItemLayout)
		: null;
}
