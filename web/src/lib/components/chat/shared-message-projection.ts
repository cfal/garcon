import { parseChatMessage, type ChatMessage, type ToolUseChatMessage } from '$shared/chat-types';
import { projectCommandOutput } from '$shared/command-output-projection.js';
import { commandResultPresentation } from '$lib/chat/transcript/command-result-presentation.js';
import { ConversationToolPairing, shouldRenderPairedToolResult } from '$lib/chat/transcript/conversation-feed-items.js';

export interface SharedMessageEntry {
	index: number;
	message: ChatMessage;
}

interface RenderedEntry extends SharedMessageEntry {
	pairedTool?: ToolUseChatMessage;
}

export function parseSharedMessages(rawMessages: unknown[], start: number): SharedMessageEntry[] {
	const entries: SharedMessageEntry[] = [];
	rawMessages.forEach((raw, offset) => {
		try {
			const message = parseChatMessage(raw);
			if (message) entries.push({ index: start + offset, message });
		} catch {
			// A malformed row must not shift the snapshot indices of later messages.
		}
	});
	return entries;
}

function sharesResult(tool: ToolUseChatMessage): boolean {
	return tool.type === 'schedule-tool-use'
		|| tool.type === 'antigravity-enter-plan-mode-tool-use'
		|| tool.type === 'antigravity-exit-plan-mode-tool-use';
}

export function projectSharedMessages(entries: SharedMessageEntry[], frozenMessageCount: number): RenderedEntry[] {
	const output = projectCommandOutput(entries.map(entry => entry.message));
	const bindingStart = frozenMessageCount ? frozenMessageCount + 1 : undefined;
	const rows = entries.map(({ index, message }) => ({
		kind: 'message' as const, id: String(index), ordinal: index + 1, message,
	}));
	const pairs = new ConversationToolPairing().append(rows, bindingStart);
	const rendered: RenderedEntry[] = [];
	for (const [offset, entry] of entries.entries()) {
		const message = output.get(offset) ?? entry.message;
		if (message.type === 'command-result' && commandResultPresentation(message.result) === 'hidden') continue;
		if (message.type === 'tool-result') {
			const tool = pairs.toolUseByResultRowId.get(String(entry.index));
			if (tool && sharesResult(tool) && shouldRenderPairedToolResult(tool, message)) {
				rendered.push({ ...entry, pairedTool: tool });
			}
		} else {
			rendered.push({ ...entry, message });
		}
	}
	return rendered;
}
