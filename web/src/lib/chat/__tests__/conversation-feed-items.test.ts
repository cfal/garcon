import { describe, expect, it } from 'vitest';
import {
	AssistantMessage,
	BashToolUseMessage,
	PermissionCancelledMessage,
	PermissionResolvedMessage,
	ReadToolUseMessage,
	ToolResultMessage,
	UserMessage,
	type ChatMessage,
} from '$shared/chat-types';
import {
	buildConversationFeedRenderItems,
	buildConversationFeedRenderModel,
} from '../conversation-feed-items';
import type { LocalNoticeRow } from '../local-notice';

const TS = '2026-05-29T00:00:00.000Z';

function rows(messages: ChatMessage[]) {
	return messages.map((message, index) => ({ kind: 'message' as const, id: `row-${index}`, message }));
}

function notice(content: string): LocalNoticeRow {
	return {
		kind: 'local-notice',
		id: `notice-${content}`,
		noticeType: 'warning',
		content,
		timestamp: TS,
	};
}

describe('buildConversationFeedRenderItems', () => {
	it('groups adjacent bash tool uses into one render item', () => {
		const messages = [
			new UserMessage(TS, 'start'),
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'rg foo'),
			new AssistantMessage(TS, 'done'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));

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

		const items = buildConversationFeedRenderItems(rows(messages));

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

		const items = buildConversationFeedRenderItems(rows(messages));

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

		const firstItems = buildConversationFeedRenderItems(rows(firstBatch));
		const secondItems = buildConversationFeedRenderItems(rows(secondBatch));

		expect(firstItems[0]).toMatchObject({ kind: 'bash-group' });
		expect(secondItems[0]).toMatchObject({ kind: 'bash-group' });
		expect(firstItems[0].id).toBe(secondItems[0].id);
	});

	it('builds render items and terminal lookup indexes in one pass', () => {
		const messages = [
			new BashToolUseMessage(TS, 'bash-1', 'pwd'),
			new ToolResultMessage(TS, 'bash-1', { content: 'ok' }, false),
			new PermissionResolvedMessage(TS, 'perm-1', true),
			new PermissionCancelledMessage(TS, 'perm-2', 'cancelled'),
			new AssistantMessage(TS, 'done'),
		];

		const model = buildConversationFeedRenderModel(rows(messages));

		expect(model.items.map((item) => item.kind)).toEqual(['message', 'message']);
		expect(model.toolResultIndex.get('bash-1')?.content).toEqual({ content: 'ok' });
		expect(model.permissionTerminalById.get('perm-1')).toEqual({ state: 'resolved', allowed: true });
		expect(model.permissionTerminalById.get('perm-2')).toEqual({
			state: 'cancelled',
			reason: 'cancelled',
		});
	});

	it('keeps local notices as their own render items and breaks assistant grouping', () => {
		const firstAssistant = new AssistantMessage(TS, 'before');
		const secondAssistant = new AssistantMessage(TS, 'after');
		const localNotice = notice('Chat interrupted by user.');

		const items = buildConversationFeedRenderItems([
			{ kind: 'message', id: 'assistant-1', message: firstAssistant },
			localNotice,
			{ kind: 'message', id: 'assistant-2', message: secondAssistant },
		]);

		expect(items.map((item) => item.kind)).toEqual(['message', 'local-notice', 'message']);
		expect(items[1]).toMatchObject({
			kind: 'local-notice',
			notice: localNotice,
			prevMessage: firstAssistant,
		});
		expect(items[2]).toMatchObject({
			kind: 'message',
			message: secondAssistant,
			prevMessage: null,
		});
	});

	it('derives unique render keys for bash groups with duplicate starting tool IDs', () => {
		const messages = [
			new BashToolUseMessage(TS, 'dup-bash', 'pwd'),
			new BashToolUseMessage(TS, 'bash-2', 'ls'),
			new AssistantMessage(TS, 'separator'),
			new BashToolUseMessage(TS, 'dup-bash', 'git status'),
			new BashToolUseMessage(TS, 'bash-4', 'bun test'),
		];

		const items = buildConversationFeedRenderItems(rows(messages));
		const keys = items.map((item) => item.id);

		expect(items.filter((item) => item.kind === 'bash-group')).toHaveLength(2);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
