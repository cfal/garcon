import { describe, expect, it } from 'vitest';
import {
	BashToolUseMessage,
	GlobToolUseMessage,
	ToolResultMessage,
	TranscriptNoticeMessage,
	UserMessage,
} from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';
import type { ConversationFeedRenderItem } from '$lib/chat/transcript/conversation-feed-items.js';
import { buildConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
import {
	appendConversationVirtualTranscriptTail,
	buildConversationVirtualFeedModel,
	estimateConversationFeedItemSize,
} from '../conversation-feed-virtual-items.js';

function userItem(index: number): Extract<ConversationFeedRenderItem, { kind: 'message' }> {
	const rowId = `generation-1:${index}`;
	return {
		kind: 'message',
		id: rowId,
		message: new UserMessage('2026-08-03T00:00:00.000Z', `message ${index}`),
		index,
		ordinal: index,
	};
}

function build(transcriptItems: ConversationFeedRenderItem[]) {
	return buildConversationVirtualFeedModel({
		showRefreshError: false,
		showEarlierBoundary: false,
		showLaterBoundary: false,
		reserveComposerTraySpace: false,
		transcriptViewId: 'view-1',
		surfaceIdentity: 'chat-1:generation-1',
		transcriptItems,
		pendingPermissions: [],
	});
}

describe('conversation virtual feed model', () => {
	it('builds stable key, row, and target indexes for 20,000 rows', () => {
		const model = build(Array.from({ length: 20_000 }, (_, index) => userItem(index + 1)));

		expect(model.items).toHaveLength(20_002);
		expect(model.indexByKey.size).toBe(20_002);
		expect(model.indexByRowId.size).toBe(20_000);
		expect(model.targetByDomAnchorId.size).toBe(20_000);
		expect(model.indexByRowId.get('generation-1:20000')).toBe(20_000);
		expect(model.targetByDomAnchorId.get('generation-1:20000')).toEqual({
			index: 20_000,
			innerRowId: 'generation-1:20000',
		});
	});

	it('namespaces virtual identity separately from durable row identity', () => {
		const item = userItem(1);
		const first = build([item]);
		const second = buildConversationVirtualFeedModel({
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: false,
			reserveComposerTraySpace: false,
			transcriptViewId: 'view-1',
			surfaceIdentity: 'chat-2:generation-1',
			transcriptItems: [item],
			pendingPermissions: [],
		});

		expect(first.items[0]?.key).not.toBe(second.items[0]?.key);
		expect(first.indexByRowId.get('generation-1:1')).toBe(1);
		expect(second.indexByRowId.get('generation-1:1')).toBe(1);
	});

	it('rejects duplicate virtual keys before measurement state can be shared', () => {
		const duplicate = { ...userItem(2), id: userItem(1).id };
		expect(() => build([userItem(1), duplicate])).toThrow('Duplicate conversation feed key');
	});

	it('indexes each exact tool result occurrence in its own virtual row', () => {
		const toolRowId = 'generation-1:10';
		const resultRowId = 'generation-1:11';
		const toolItem: ConversationFeedRenderItem = {
			kind: 'message',
			id: toolRowId,
			message: new BashToolUseMessage('', 'reused-provider-id', 'pwd'),
			index: 10,
			ordinal: 10,
		};
		const resultItem: ConversationFeedRenderItem = {
			kind: 'message',
			id: resultRowId,
			message: new ToolResultMessage('', 'reused-provider-id', { raw: '/tmp' }, false),
			index: 11,
			ordinal: 11,
		};
		const model = buildConversationVirtualFeedModel({
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: false,
			reserveComposerTraySpace: false,
			transcriptViewId: 'view-1',
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [toolItem, resultItem],
			pendingPermissions: [],
		});

		expect(model.targetByDomAnchorId.get(`tool-result-${resultRowId}`)).toEqual({
			index: 2,
			innerRowId: resultRowId,
		});
		expect(model.items[2]).toMatchObject({ spacingAfter: 'none' });
		expect(estimateConversationFeedItemSize(model.items[2])).toBe(0);
	});

	it('gives visible collapsible tool results their own estimated geometry', () => {
		const tool = new GlobToolUseMessage('', 'glob-1', '**/*.ts');
		const result = new ToolResultMessage('', 'glob-1', { filenames: ['a.ts'] }, false);
		const renderModel = buildConversationFeedRenderModel([
			{ kind: 'message', id: 'generation-1:10', ordinal: 10, message: tool },
			{ kind: 'message', id: 'generation-1:11', ordinal: 11, message: result },
		]);
		const model = build(renderModel.items);

		expect(model.items[2]).toMatchObject({ spacingAfter: 'transcript' });
		expect(estimateConversationFeedItemSize(model.items[2])).toBeGreaterThan(0);
	});

	it('keeps transcript and feed controls in one unscaled coordinate system', () => {
		const transcript = build([userItem(1)]).items[1];
		const boundary = buildConversationVirtualFeedModel({
			showRefreshError: false,
			showEarlierBoundary: true,
			showLaterBoundary: false,
			reserveComposerTraySpace: false,
			transcriptViewId: 'view-1',
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [],
			pendingPermissions: [],
		}).items[1];

		expect(estimateConversationFeedItemSize(transcript)).toBe(124);
		expect(estimateConversationFeedItemSize(boundary)).toBe(44);
	});

	it('reserves header geometry for presented user messages', () => {
		const ordinary = build([userItem(1)]).items[1]!;
		const collapsibleItem = userItem(2);
		collapsibleItem.message = new UserMessage(
			'2026-08-03T00:00:00.000Z',
			'message 2',
			undefined,
			undefined,
			{ origin: 'cli', disclosure: 'collapsed' },
		);
		const collapsible = build([collapsibleItem]).items[1]!;
		const presentedItem = userItem(2);
		presentedItem.message = new UserMessage(
			'2026-08-03T00:00:00.000Z',
			'message 2',
			undefined,
			undefined,
			{ origin: 'cli', style: 'info' },
		);
		const presented = build([presentedItem]).items[1]!;

		expect(estimateConversationFeedItemSize(ordinary)).toBe(124);
		expect(estimateConversationFeedItemSize(collapsible)).toBe(124);
		expect(estimateConversationFeedItemSize(presented)).toBe(156);
	});

	it('bounds collapsed handoff notices while plain notices stay compact', () => {
		const plain = new TranscriptNoticeMessage(
			'2026-08-03T00:00:00.000Z',
			'Earlier chat history was small enough to carry over as context.',
			undefined,
			'History carried without compaction',
		);
		const handoff = new TranscriptNoticeMessage(
			'2026-08-03T00:00:00.000Z',
			'# Summary\n\nCarried context.',
			{ type: 'handoff-summary' },
			'Handoff summary',
		);
		const model = build([
			{ kind: 'message', id: 'generation-1:1', index: 1, ordinal: 1, message: plain },
			{ kind: 'message', id: 'generation-1:2', index: 2, ordinal: 2, message: handoff },
		]);

		expect(estimateConversationFeedItemSize(model.items[1])).toBe(64);
		expect(estimateConversationFeedItemSize(model.items[2])).toBe(242);
	});

	it('reserves compact Markdown geometry for sent and received inter-agent messages', () => {
		const sent = new TranscriptNoticeMessage('2026-08-03T00:00:00.000Z', 'Message body.', {
			type: 'inter-agent-message-outcome',
			results: [{ chatId: '1788090107980901', status: 'delivered' }],
		});
		const received = new TranscriptNoticeMessage('2026-08-03T00:00:00.000Z', 'Message body.', {
			type: 'inter-agent-message-received',
			fromChatId: '1788090107980900',
		});
		const model = build([
			{ kind: 'message', id: 'generation-1:1', index: 1, ordinal: 1, message: sent },
			{ kind: 'message', id: 'generation-1:2', index: 2, ordinal: 2, message: received },
		]);

		expect(estimateConversationFeedItemSize(model.items[1])).toBe(242);
		expect(estimateConversationFeedItemSize(model.items[2])).toBe(242);
	});

	it('includes viewport geometry and established floating permission spacing', () => {
		const permission: PendingPermissionRequest = {
			chatId: 'chat-1',
			permissionOccurrenceId: 'incarnation-1',
			requestedTool: new BashToolUseMessage('', 'tool-1', 'pwd'),
		};
		const model = buildConversationVirtualFeedModel({
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: false,
			reserveComposerTraySpace: true,
			transcriptViewId: 'view-1',
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [userItem(1)],
			pendingPermissions: [
				permission,
				{
					...permission,
					permissionOccurrenceId: 'incarnation-2',
				},
			],
		});

		expect(model.items.map((item) => item.kind)).toEqual([
			'viewport-start-spacer',
			'transcript',
			'permission',
			'permission',
			'viewport-end-spacer',
		]);
		expect(model.items[2]).toMatchObject({ leadingSpacing: true, spacingAfter: 'responsive-feed' });
		expect(model.items[3]).toMatchObject({ leadingSpacing: false, spacingAfter: 'none' });
		expect(estimateConversationFeedItemSize(model.items.at(-1))).toBe(56);
	});

	it('gives permission occurrences distinct virtual identities', () => {
		const first = {
			chatId: 'chat-1',
			permissionOccurrenceId: 'occurrence-1',
			requestedTool: new BashToolUseMessage('', 'tool-1', 'printf first'),
		} satisfies PendingPermissionRequest;
		const second = {
			...first,
			permissionOccurrenceId: 'occurrence-2',
			requestedTool: new BashToolUseMessage('', 'tool-2', 'printf second'),
		} satisfies PendingPermissionRequest;

		const model = buildConversationVirtualFeedModel({
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: false,
			reserveComposerTraySpace: false,
			transcriptViewId: 'view-1',
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [],
			pendingPermissions: [first, second],
		});
		const permissions = model.items.filter((item) => item.kind === 'permission');

		expect(permissions).toHaveLength(2);
		expect(new Set(permissions.map((item) => item.key)).size).toBe(2);
		expect(
			permissions.map((item) => item.kind === 'permission' && item.request.permissionOccurrenceId),
		).toEqual(['occurrence-1', 'occurrence-2']);
	});

	it('updates suffix indexes when transcript items append incrementally', () => {
		const permission: PendingPermissionRequest = {
			chatId: 'chat-1',
			permissionOccurrenceId: 'incarnation-1',
			requestedTool: new BashToolUseMessage('', 'tool-1', 'pwd'),
		};
		const model = buildConversationVirtualFeedModel({
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: true,
			reserveComposerTraySpace: false,
			transcriptViewId: 'view-1',
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [userItem(1)],
			pendingPermissions: [permission],
		});
		const priorEndKey = model.items.at(-1)!.key;
		const priorEndIndex = model.items.length - 1;
		const priorTranscriptTail = model.items[1];

		const appended = appendConversationVirtualTranscriptTail(model, 'chat-1:generation-1', [
			userItem(2),
		]);

		expect(appended?.items.map((item) => item.kind)).toEqual([
			'viewport-start-spacer',
			'transcript',
			'transcript',
			'later-boundary',
			'permission',
			'viewport-end-spacer',
		]);
		expect(appended?.items[1]).toMatchObject({ spacingAfter: 'transcript' });
		expect(appended?.items[1]).toBe(priorTranscriptTail);
		expect(appended?.items[2]).toMatchObject({ spacingAfter: 'transcript' });
		expect(appended?.indexByKey).not.toBe(model.indexByKey);
		expect(appended?.indexByRowId).not.toBe(model.indexByRowId);
		expect(appended?.targetByDomAnchorId).not.toBe(model.targetByDomAnchorId);
		expect(model.indexByRowId.has('generation-1:2')).toBe(false);
		expect(model.targetByDomAnchorId.has('generation-1:2')).toBe(false);
		expect(model.indexByKey.get(priorEndKey)).toBe(priorEndIndex);
		expect(appended?.indexByKey.get(priorEndKey)).toBe(priorEndIndex + 1);
		expect(appended?.indexByRowId.get('generation-1:2')).toBe(2);
		for (const [index, item] of appended?.items.entries() ?? []) {
			expect(appended?.indexByKey.get(item.key)).toBe(index);
		}
	});
});
