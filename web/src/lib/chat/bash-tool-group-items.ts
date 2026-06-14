import type { BashToolUseMessage } from '$shared/chat-types';

export interface BashToolGroupRenderItem {
	key: string;
	message: BashToolUseMessage;
}

export function buildBashToolGroupRenderItems(
	messages: BashToolUseMessage[],
): BashToolGroupRenderItem[] {
	const seen = new Map<string, number>();
	return messages.map((message, index) => {
		const baseKey = message.toolId || `missing-tool-id-${index}`;
		const duplicateIndex = seen.get(baseKey) ?? 0;
		seen.set(baseKey, duplicateIndex + 1);
		const key = duplicateIndex === 0 ? baseKey : `${baseKey}#${duplicateIndex}`;
		return { key, message };
	});
}
