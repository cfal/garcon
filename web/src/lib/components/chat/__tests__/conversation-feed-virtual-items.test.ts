import { describe, expect, it } from 'vitest';
import { BashToolUseMessage, UserMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';
import type { ReconciledConversationFeedRenderItem } from '$lib/chat/transcript/conversation-feed-render-model.js';
import {
	buildConversationVirtualFeedModel,
	estimateConversationFeedItemSize,
} from '../conversation-feed-virtual-items.js';

function userItem(index: number): ReconciledConversationFeedRenderItem {
	const rowId = `generation-1:${index}`;
	return {
		kind: 'message',
		id: `message:${rowId}`,
		rowIds: [rowId],
		message: new UserMessage('2026-08-03T00:00:00.000Z', `message ${index}`),
		index,
		seq: index,
		prevMessage: null,
		virtualKey: rowId,
	};
}

function build(transcriptItems: ReconciledConversationFeedRenderItem[]) {
	return buildConversationVirtualFeedModel({
		showTopToolbarSpacer: false,
		showRefreshError: false,
		showEarlierBoundary: false,
		showLaterBoundary: false,
		reserveComposerTraySpace: false,
		surfaceIdentity: 'chat-1:generation-1',
		transcriptItems,
		floatingPermissions: [],
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
			showTopToolbarSpacer: false,
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: false,
			reserveComposerTraySpace: false,
			surfaceIdentity: 'chat-2:generation-1',
			transcriptItems: [item],
			floatingPermissions: [],
		});

		expect(first.items[0]?.key).not.toBe(second.items[0]?.key);
		expect(first.indexByRowId.get('generation-1:1')).toBe(1);
		expect(second.indexByRowId.get('generation-1:1')).toBe(1);
	});

	it('rejects duplicate virtual keys before measurement state can be shared', () => {
		const duplicate = { ...userItem(2), virtualKey: userItem(1).virtualKey };
		expect(() => build([userItem(1), duplicate])).toThrow('Duplicate conversation feed key');
	});

	it('scales transcript estimates without scaling feed controls', () => {
		const transcript = build([userItem(1)]).items[1];
		const boundary = buildConversationVirtualFeedModel({
			showTopToolbarSpacer: false,
			showRefreshError: false,
			showEarlierBoundary: true,
			showLaterBoundary: false,
			reserveComposerTraySpace: false,
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [],
			floatingPermissions: [],
		}).items[1];

		expect(estimateConversationFeedItemSize(transcript, 0.7)).toBeCloseTo(78.4);
		expect(estimateConversationFeedItemSize(boundary, 0.7)).toBe(44);
	});

	it('includes viewport geometry and established floating permission spacing', () => {
		const permission: PendingPermissionRequest = {
			chatId: 'chat-1',
			permissionRequestId: 'permission-1',
			requestedTool: new BashToolUseMessage('', 'tool-1', 'pwd'),
		};
		const model = buildConversationVirtualFeedModel({
			showTopToolbarSpacer: false,
			showRefreshError: false,
			showEarlierBoundary: false,
			showLaterBoundary: false,
			reserveComposerTraySpace: true,
			surfaceIdentity: 'chat-1:generation-1',
			transcriptItems: [userItem(1)],
			floatingPermissions: [permission, { ...permission, permissionRequestId: 'permission-2' }],
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
		expect(estimateConversationFeedItemSize(model.items.at(-1), 1)).toBe(56);
	});
});
