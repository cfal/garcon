import { isToolUseMessage, ToolResultMessage } from '$shared/chat-types';
import {
	isHandoffSummaryNoticeDetail,
	isInterAgentMessageOutcomeNoticeDetail,
	isInterAgentMessageReceivedNoticeDetail,
} from '$shared/transcript-notice-details';
import type { PendingPermissionRequest } from '$lib/types/chat';
import {
	conversationFeedItemLayout,
	type ConversationFeedRenderItem,
} from '$lib/chat/transcript/conversation-feed-items.js';

export type ConversationFeedSpacing = 'responsive-feed' | 'transcript' | 'none';

export type ConversationVirtualFeedItem =
	| { kind: 'viewport-start-spacer'; key: string; spacingAfter: 'none' }
	| { kind: 'refresh-error'; key: string; spacingAfter: 'none' }
	| { kind: 'earlier-boundary'; key: string; spacingAfter: 'none' }
	| {
			kind: 'transcript';
			key: string;
			item: ConversationFeedRenderItem;
			spacingAfter: ConversationFeedSpacing;
	  }
	| { kind: 'later-boundary'; key: string; spacingAfter: 'none' }
	| {
			kind: 'permission';
			key: string;
			request: PendingPermissionRequest;
			leadingSpacing: boolean;
			spacingAfter: 'responsive-feed' | 'none';
	  }
	| {
			kind: 'viewport-end-spacer';
			key: string;
			reserveComposerTraySpace: boolean;
			spacingAfter: 'none';
	  };

export interface ConversationVirtualTarget {
	index: number;
	innerRowId: string;
}

export interface ConversationVirtualFeedModel {
	items: ConversationVirtualFeedItem[];
	indexByKey: Map<string, number>;
	indexByRowId: Map<string, number>;
	targetByDomAnchorId: Map<string, ConversationVirtualTarget>;
	transcriptStartIndex: number;
	transcriptEndIndex: number;
}

export interface ConversationVirtualFeedInput {
	showRefreshError: boolean;
	showEarlierBoundary: boolean;
	showLaterBoundary: boolean;
	reserveComposerTraySpace: boolean;
	surfaceIdentity: string;
	transcriptItems: ConversationFeedRenderItem[];
	transcriptViewId: string;
	pendingPermissions: PendingPermissionRequest[];
}

function namespacedKey(surfaceIdentity: string, localKey: string): string {
	return JSON.stringify([surfaceIdentity, localKey]);
}

function toolAnchorIds(item: ConversationFeedRenderItem): string[] {
	if (item.kind !== 'message') return [];
	if (isToolUseMessage(item.message)) {
		return [`tool-input-${item.message.toolId}`];
	}
	if (item.message instanceof ToolResultMessage) {
		return [`tool-result-${item.id}`];
	}
	return [];
}

function transcriptSpacing(item: ConversationFeedRenderItem): ConversationFeedSpacing {
	return conversationFeedItemLayout(item) === 'hidden' ? 'none' : 'transcript';
}

// Consumes the requests anchored to this row so a later row cannot claim them again.
function takeAnchoredPermissions(
	permissionsByAnchor: Map<number, PendingPermissionRequest[]>,
	item: ConversationFeedRenderItem,
): PendingPermissionRequest[] {
	if (item.kind !== 'message' || item.ordinal === undefined) return [];
	const anchored = permissionsByAnchor.get(item.ordinal) ?? [];
	permissionsByAnchor.delete(item.ordinal);
	return anchored;
}

export function buildConversationVirtualFeedModel(
	input: ConversationVirtualFeedInput,
): ConversationVirtualFeedModel {
	const items: ConversationVirtualFeedItem[] = [];
	const key = (localKey: string): string => namespacedKey(input.surfaceIdentity, localKey);
	items.push({
		kind: 'viewport-start-spacer',
		key: key('prefix:viewport-start-spacer'),
		spacingAfter: 'none',
	});

	if (input.showRefreshError) {
		items.push({
			kind: 'refresh-error',
			key: key('prefix:refresh-error'),
			spacingAfter: 'none',
		});
	}
	if (input.showEarlierBoundary) {
		items.push({
			kind: 'earlier-boundary',
			key: key('prefix:earlier-boundary'),
			spacingAfter: 'none',
		});
	}
	const transcriptStartIndex = items.length;

	// A permission request renders after the row it was raised against, so it stays put as
	// the transcript grows. Requests whose anchor belongs to another view, or to a row this
	// window has not loaded, fall through to the end of the feed.
	const permissionsByAnchor = new Map<number, PendingPermissionRequest[]>();
	const detachedPermissions: PendingPermissionRequest[] = [];
	for (const permission of input.pendingPermissions) {
		const anchor = permission.transcript;
		if (!anchor || anchor.transcriptViewId !== input.transcriptViewId) {
			detachedPermissions.push(permission);
			continue;
		}
		const anchored = permissionsByAnchor.get(anchor.afterOrdinal) ?? [];
		anchored.push(permission);
		permissionsByAnchor.set(anchor.afterOrdinal, anchored);
	}

	for (const [transcriptIndex, item] of input.transcriptItems.entries()) {
		const anchored = takeAnchoredPermissions(permissionsByAnchor, item);
		const isLastItem = transcriptIndex === input.transcriptItems.length - 1;
		items.push({
			kind: 'transcript',
			key: key(`transcript:${item.id}`),
			item,
			spacingAfter: anchored.length > 0 ? 'none' : transcriptSpacing(item),
		});
		for (const [permissionIndex, request] of anchored.entries()) {
			const isLastAnchored = permissionIndex === anchored.length - 1;
			items.push(
				permissionItem(key, request, permissionIndex === 0, !(isLastAnchored && isLastItem)),
			);
		}
	}
	for (const permissions of permissionsByAnchor.values()) detachedPermissions.push(...permissions);
	const transcriptEndIndex = items.length;

	if (input.showLaterBoundary) {
		items.push({
			kind: 'later-boundary',
			key: key('suffix:later-boundary'),
			spacingAfter: 'none',
		});
	}
	for (const [permissionIndex, request] of detachedPermissions.entries()) {
		items.push(
			permissionItem(
				key,
				request,
				permissionIndex === 0,
				permissionIndex < detachedPermissions.length - 1,
			),
		);
	}
	items.push({
		kind: 'viewport-end-spacer',
		key: key('suffix:viewport-end-spacer'),
		reserveComposerTraySpace: input.reserveComposerTraySpace,
		spacingAfter: 'none',
	});

	const indexByKey = new Map<string, number>();
	const indexByRowId = new Map<string, number>();
	const targetByDomAnchorId = new Map<string, ConversationVirtualTarget>();
	for (const [index, virtualItem] of items.entries()) {
		if (indexByKey.has(virtualItem.key)) {
			throw new Error(`Duplicate conversation feed key: ${virtualItem.key}`);
		}
		indexByKey.set(virtualItem.key, index);
		if (virtualItem.kind !== 'transcript') continue;

		indexByRowId.set(virtualItem.item.id, index);
		targetByDomAnchorId.set(virtualItem.item.id, {
			index,
			innerRowId: virtualItem.item.id,
		});
		for (const anchorId of toolAnchorIds(virtualItem.item)) {
			targetByDomAnchorId.set(anchorId, { index, innerRowId: virtualItem.item.id });
		}
	}

	return {
		items,
		indexByKey,
		indexByRowId,
		targetByDomAnchorId,
		transcriptStartIndex,
		transcriptEndIndex,
	};
}

export function appendConversationVirtualTranscriptTail(
	model: ConversationVirtualFeedModel,
	surfaceIdentity: string,
	appendedItems: ConversationFeedRenderItem[],
): ConversationVirtualFeedModel | null {
	if (appendedItems.length === 0) return null;
	const insertIndex = model.transcriptEndIndex;
	const appendedVirtualItems = appendedItems.map((item): ConversationVirtualFeedItem => ({
		kind: 'transcript',
		key: namespacedKey(surfaceIdentity, `transcript:${item.id}`),
		item,
		spacingAfter: transcriptSpacing(item),
	}));
	if (appendedVirtualItems.some((item) => model.indexByKey.has(item.key))) return null;

	const items = model.items.slice();
	items.splice(insertIndex, 0, ...appendedVirtualItems);

	const indexByKey = new Map(model.indexByKey);
	const indexByRowId = new Map(model.indexByRowId);
	const targetByDomAnchorId = new Map(model.targetByDomAnchorId);
	for (let index = insertIndex; index < items.length; index += 1) {
		indexByKey.set(items[index].key, index);
	}
	for (const [offset, virtualItem] of appendedVirtualItems.entries()) {
		if (virtualItem.kind !== 'transcript') continue;
		const index = insertIndex + offset;
		indexByRowId.set(virtualItem.item.id, index);
		targetByDomAnchorId.set(virtualItem.item.id, {
			index,
			innerRowId: virtualItem.item.id,
		});
		for (const anchorId of toolAnchorIds(virtualItem.item)) {
			targetByDomAnchorId.set(anchorId, { index, innerRowId: virtualItem.item.id });
		}
	}

	return {
		...model,
		items,
		indexByKey,
		indexByRowId,
		targetByDomAnchorId,
		transcriptEndIndex: insertIndex + appendedVirtualItems.length,
	};
}

export function estimateConversationFeedItemSize(
	item: ConversationVirtualFeedItem | undefined,
): number {
	if (!item) return 120;
	if (item.kind === 'viewport-start-spacer') return 16;
	if (item.kind === 'viewport-end-spacer') return item.reserveComposerTraySpace ? 56 : 16;
	if (
		item.kind === 'refresh-error' ||
		item.kind === 'earlier-boundary' ||
		item.kind === 'later-boundary'
	) {
		return 44;
	}
	if (item.kind === 'permission') {
		const leadingSpacing = item.leadingSpacing ? 8 : 0;
		const trailingSpacing = item.spacingAfter === 'responsive-feed' ? 12 : 0;
		return 240 + leadingSpacing + trailingSpacing;
	}

	const renderItem = item.item;
	const spacing = item.spacingAfter === 'transcript' ? 12 : 0;
	const layout = conversationFeedItemLayout(renderItem);
	if (layout === 'hidden') return 0;
	if (layout === 'permission') return 240 + spacing;
	if (renderItem.kind === 'local-notice') return 52 + spacing;
	if (renderItem.message.type === 'transcript-notice') {
		if (isInterAgentMessageOutcomeNoticeDetail(renderItem.message.detail)) {
			const additionalRecipients = Math.max(0, renderItem.message.detail.results.length - 1);
			return 230 + additionalRecipients * 26 + spacing;
		}
		if (isInterAgentMessageReceivedNoticeDetail(renderItem.message.detail)) {
			return 230 + spacing;
		}
		// The collapsed handoff body is clamp-bounded, so its default height is stable
		// enough to estimate even though expansion is measured after render.
		return (isHandoffSummaryNoticeDetail(renderItem.message.detail) ? 230 : 52) + spacing;
	}
	if (renderItem.message.type === 'user-message') {
		return (renderItem.message.presentation?.style ? 144 : 112) + spacing;
	}
	if (renderItem.message.type === 'assistant-message') return 180 + spacing;
	if (renderItem.message.type === 'thinking') return 160 + spacing;
	if (renderItem.message.type === 'cli-row') return 112 + spacing;
	return 96 + spacing;
}

function permissionItem(
	key: (localKey: string) => string,
	request: PendingPermissionRequest,
	leadingSpacing: boolean,
	trailingSpacing: boolean,
): ConversationVirtualFeedItem {
	return {
		kind: 'permission',
		key: key(`permission:${request.permissionOccurrenceId}`),
		request,
		leadingSpacing,
		spacingAfter: trailingSpacing ? 'responsive-feed' : 'none',
	};
}
