import { describe, expect, it } from 'vitest';
import {
	BashToolUseMessage,
	EditToolUseMessage,
	ExecToolUseMessage,
	ExternalToolUseMessage,
	McpToolUseMessage,
	ReadToolUseMessage,
	UnknownToolUseMessage,
	WriteToolUseMessage,
} from '$shared/chat-types';
import type { ConversationFeedMessageRenderItem } from '$lib/chat/transcript/conversation-feed-items.js';
import { summarizeToolUses } from '../tool-use-summary.js';

const TS = '2026-08-03T00:00:00.000Z';

function item(message: ConversationFeedMessageRenderItem['message'], index: number): ConversationFeedMessageRenderItem {
	return { kind: 'message', id: `view:${index}`, index, ordinal: index, message };
}

describe('summarizeToolUses', () => {
	it('counts invocations by display category in first-occurrence order', () => {
		const members = [
			...Array.from({ length: 3 }, (_, index) => item(new ReadToolUseMessage(TS, `read-${index}`, '/private/a'), index)),
			...Array.from({ length: 5 }, (_, index) => item(new WriteToolUseMessage(TS, `write-${index}`, '/private/b', 'secret'), index + 3)),
			...Array.from({ length: 5 }, (_, index) => item(new BashToolUseMessage(TS, `bash-${index}`, 'private command'), index + 8)),
		];
		const summary = summarizeToolUses(members);
		expect(summary.count).toBe(13);
		expect(summary.visibleLabel).toBe('13 tool uses: Read 3, Write 5, Bash 5');
		expect(summary.accessibleLabel).toBe(summary.visibleLabel);
		expect(summary.visibleLabel).not.toMatch(/private|secret/);
	});

	it('bounds visual categories without shortening the accessible name', () => {
		const summary = summarizeToolUses([
			item(new ReadToolUseMessage(TS, 'r', '/a'), 1),
			item(new WriteToolUseMessage(TS, 'w', '/a'), 2),
			item(new BashToolUseMessage(TS, 'b', 'pwd'), 3),
			item(new EditToolUseMessage(TS, 'e', '/a'), 4),
		]);
		expect(summary.visibleLabel).toBe('4 tool uses: Read 1, Write 1, Bash 1, +1 more');
		expect(summary.accessibleLabel).toBe('4 tool uses: Read 1, Write 1, Bash 1, Edit 1');
	});

	it('never exposes provider names or payloads in generic categories', () => {
		const summary = summarizeToolUses([
			item(new UnknownToolUseMessage(TS, 'u', 'private_raw_name', { secret: 'hidden' }), 1),
			item(new ExternalToolUseMessage(TS, 'e', 'private_external_name', { secret: 'hidden' }), 2),
			item(new McpToolUseMessage(TS, 'm', 'private_server', 'private_tool', { secret: 'hidden' }), 3),
		]);
		expect(summary.accessibleLabel).toBe('3 tool uses: Tool 1, External tool 1, MCP tool 1');
		expect(summary.accessibleLabel).not.toMatch(/private|secret|hidden/);
	});

	it('does not split Exec counts by user-controlled language labels', () => {
		const summary = summarizeToolUses([
			item(new ExecToolUseMessage(TS, 'a', 'secret command', 'private-language-name'), 1),
			item(new ExecToolUseMessage(TS, 'b', 'another secret', 'javascript'), 2),
		]);
		expect(summary.accessibleLabel).toBe('2 tool uses: Exec 2');
		expect(summary.visibleLabel).not.toMatch(/secret|private|javascript/);
	});
});
