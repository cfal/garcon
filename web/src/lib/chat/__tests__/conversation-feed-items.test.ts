import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
	ToolResultMessage,
	UserMessage,
} from '$shared/chat-types';
import { buildConversationFeedRenderItems } from '../conversation-feed-items';

const TS = '2026-05-29T00:00:00.000Z';

describe('buildConversationFeedRenderItems', () => {
	it('groups adjacent bash tool uses into one render item', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
			new AssistantMessage(TS, 'done'),
		];

		const items = buildConversationFeedRenderItems(messages);

		expect(items).toHaveLength(3);
		expect(items[1]).toMatchObject({ kind: 'bash-group' });
		if (items[1].kind !== 'bash-group') throw new Error('expected bash group');
		expect(items[1].messages.map((message) => message.command)).toEqual(['pwd', 'rg foo']);
		expect(items[2]).toMatchObject({ kind: 'message', prevMessage: messages[2] });
	});

	it('keeps a single bash tool use as a normal message', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ReadToolUseMessage(TS, 'read-1', '/tmp/file.ts'),
		];

		const items = buildConversationFeedRenderItems(messages);

		expect(items).toHaveLength(3);
		expect(items[1]).toMatchObject({ kind: 'message', message: messages[1] });
	});

	it('groups bash tool uses across hidden tool results', () => {
		const messages = [
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ToolResultMessage(TS, 'bash-1', { content: 'ok' }, false),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
			new ToolResultMessage(TS, 'bash-2', { content: 'ok' }, false),
		];

		const items = buildConversationFeedRenderItems(messages);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: 'bash-group' });
		if (items[0].kind !== 'bash-group') throw new Error('expected bash group');
		expect(items[0].messages.map((message) => message.toolId)).toEqual(['bash-1', 'bash-2']);
	});

	it('keeps the group id stable as more adjacent bash tool uses arrive', () => {
		const firstBatch = [
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
		];
		const secondBatch = [...firstBatch, new BashToolUseMessage(TS, 'bash-3', 'bun run test')];

		const firstItems = buildConversationFeedRenderItems(firstBatch);
		const secondItems = buildConversationFeedRenderItems(secondBatch);

		expect(firstItems[0]).toMatchObject({ kind: 'bash-group' });
		expect(secondItems[0]).toMatchObject({ kind: 'bash-group' });
		expect(firstItems[0].id).toBe(secondItems[0].id);
	});
});
