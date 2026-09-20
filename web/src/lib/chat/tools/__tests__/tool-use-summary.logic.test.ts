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
		it('counts invocations by category in first-occurrence order', () => {
		const members = [
			...Array.from({ length: 3 }, (_, index) => item(new ReadToolUseMessage(TS, `read-${index}`, '/private/a'), index)),
			...Array.from({ length: 5 }, (_, index) => item(new WriteToolUseMessage(TS, `write-${index}`, '/private/b', 'secret'), index + 3)),
			...Array.from({ length: 4 }, (_, index) => item(new BashToolUseMessage(TS, `bash-${index}`, 'private command'), index + 8)),
			item(new ExecToolUseMessage(TS, 'exec', 'private code', 'private language'), 12),
			item(new McpToolUseMessage(TS, 'mcp', 'private server', 'private tool', { secret: 'hidden' }), 13),
		];
		const summary = summarizeToolUses(members);
		expect(summary.count).toBe(14);
		expect(summary.label).toBe('Read 3 files, edit 5 files, execute 5 commands, an action');
		expect(summary.label).not.toMatch(/private|secret/);
	});

	it('combines related message types into readable action categories', () => {
		const summary = summarizeToolUses([
			item(new ReadToolUseMessage(TS, 'r', '/a'), 1),
			item(new WriteToolUseMessage(TS, 'w', '/a'), 2),
			item(new BashToolUseMessage(TS, 'b', 'pwd'), 3),
			item(new EditToolUseMessage(TS, 'e', '/a'), 4),
		]);
		expect(summary.label).toBe('Read a file, edit 2 files, execute a command');
	});

	it('summarizes provider tools without exposing names or payloads', () => {
		const summary = summarizeToolUses([
			item(new UnknownToolUseMessage(TS, 'u', 'private_raw_name', { secret: 'hidden' }), 1),
			item(new ExternalToolUseMessage(TS, 'e', 'private_external_name', { secret: 'hidden' }), 2),
			item(new McpToolUseMessage(TS, 'm', 'private_server', 'private_tool', { secret: 'hidden' }), 3),
		]);
		expect(summary.label).toBe('3 actions');
		expect(summary.label).not.toMatch(/private|secret|hidden/);
	});

	it('combines Bash and Exec without exposing user-controlled labels', () => {
		const summary = summarizeToolUses([
			item(new BashToolUseMessage(TS, 'bash', 'private shell command'), 1),
			item(new ExecToolUseMessage(TS, 'a', 'secret command', 'private-language-name'), 1),
			item(new ExecToolUseMessage(TS, 'b', 'another secret', 'javascript'), 2),
		]);
		expect(summary.label).toBe('Execute 3 commands');
		expect(summary.label).not.toMatch(/secret|private|javascript/);
	});

	it('counts every file in a multi-file edit', () => {
		const edit = new EditToolUseMessage(
			TS,
			'edit',
			undefined,
			undefined,
			undefined,
			[
				{ path: '/private/a', kind: 'update' },
				{ path: '/private/b', kind: 'create' },
				{ path: '/private/c', kind: 'delete' },
			],
		);
		const summary = summarizeToolUses([item(edit, 1)]);
		expect(summary.count).toBe(1);
		expect(summary.label).toBe('Edit 3 files');
		expect(summary.label).not.toMatch(/private/);
	});

	it('uses singular grammar for one tool', () => {
		const summary = summarizeToolUses([
			item(new ReadToolUseMessage(TS, 'read', '/private/file'), 1),
		]);
		expect(summary.label).toBe('Read a file');
	});
});
