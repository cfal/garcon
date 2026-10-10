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

export type ConversationEarlierBoundaryMode = 'hidden' | 'visible' | 'when-collapsed';

export type TranscriptVirtualFeedItem = {
	kind: 'transcript';
	key: string;
	item: ConversationFeedRenderItem;
	spacingAfter: ConversationFeedSpacing;
};

export type ToolGroupVirtualFeedItem = {
	kind: 'tool-group';
	key: string;
	anchorId: string;
	members: readonly TranscriptVirtualFeedItem[];
	expanded: boolean;
	spacingAfter: ConversationFeedSpacing;
};

export type ConversationVirtualFeedItem =
	| { kind: 'viewport-start-spacer'; key: string; spacingAfter: 'none' }
	| { kind: 'refresh-error'; key: string; spacingAfter: 'none' }
	| { kind: 'earlier-boundary'; key: string; spacingAfter: 'none' }
	| TranscriptVirtualFeedItem
	| ToolGroupVirtualFeedItem
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
	memberRowIdByDomAnchorId: Map<string, string>;
	representativeRowIdByKey: Map<string, string>;
	collapsedGroupByMemberRowId: Map<string, ToolGroupVirtualFeedItem>;
	transcriptStartIndex: number;
	transcriptEndIndex: number;
}

export interface ConversationVirtualFeedInput {
	showRefreshError: boolean;
	earlierBoundary: ConversationEarlierBoundaryMode;
	showLaterBoundary: boolean;
	reserveComposerTraySpace: boolean;
	surfaceIdentity: string;
	transcriptItems: ConversationFeedRenderItem[];
	transcriptViewId: string;
	pendingPermissions: PendingPermissionRequest[];
	combineToolUseMessages: boolean;
	expandedToolMemberIds: ReadonlySet<string>;
	protectedVirtualKeys: readonly string[];
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

function groupableToolInput(item: ConversationVirtualFeedItem): item is TranscriptVirtualFeedItem {
	return (
		item.kind === 'transcript' &&
		item.item.kind === 'message' &&
		isToolUseMessage(item.item.message) &&
		item.item.message.type !== 'enter-plan-mode-tool-use' &&
		conversationFeedItemLayout(item.item) === 'standard'
	);
}

function groupToolRuns(
	items: readonly ConversationVirtualFeedItem[],
	key: (localKey: string) => string,
	expandedMemberIds: ReadonlySet<string>,
	protectedVirtualKeys: ReadonlySet<string>,
): ConversationVirtualFeedItem[] {
	const grouped: ConversationVirtualFeedItem[] = [];
	let run: TranscriptVirtualFeedItem[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const first = run[0].item;
		const expanded = run.some(
			(member) => expandedMemberIds.has(member.item.id) || protectedVirtualKeys.has(member.key),
		);
		grouped.push({
			kind: 'tool-group',
			key: key(`tool-group:${first.id}`),
			anchorId: `tool-group:${first.id}`,
			members: run,
			expanded,
			spacingAfter: expanded ? 'none' : run[run.length - 1].spacingAfter,
		});
		if (expanded) grouped.push(...run);
		run = [];
	};
	for (const item of items) {
		if (groupableToolInput(item)) run.push(item);
		else {
			flush();
			grouped.push(item);
		}
	}
	flush();
	return grouped;
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

	const body: ConversationVirtualFeedItem[] = [];
	for (const [transcriptIndex, item] of input.transcriptItems.entries()) {
		const anchored = takeAnchoredPermissions(permissionsByAnchor, item);
		const isLastItem = transcriptIndex === input.transcriptItems.length - 1;
		body.push({
			kind: 'transcript',
			key: key(`transcript:${item.id}`),
			item,
			spacingAfter: anchored.length > 0 ? 'none' : transcriptSpacing(item),
		});
		for (const [permissionIndex, request] of anchored.entries()) {
			const isLastAnchored = permissionIndex === anchored.length - 1;
			body.push(
				permissionItem(key, request, permissionIndex === 0, !(isLastAnchored && isLastItem)),
			);
		}
	}
	for (const permissions of permissionsByAnchor.values()) detachedPermissions.push(...permissions);
	const transcriptKeys = new Set<string>();
	for (const item of body) {
		if (item.kind !== 'transcript') continue;
		if (transcriptKeys.has(item.key)) {
			throw new Error(`Duplicate conversation feed key: ${item.key}`);
		}
		transcriptKeys.add(item.key);
	}
	const presentedBody = input.combineToolUseMessages
		? groupToolRuns(body, key, input.expandedToolMemberIds, new Set(input.protectedVirtualKeys))
		: body;
	const hasCollapsedToolGroup = presentedBody.some(
		(item) => item.kind === 'tool-group' && !item.expanded,
	);
	if (
		input.earlierBoundary === 'visible' ||
		(input.earlierBoundary === 'when-collapsed' && hasCollapsedToolGroup)
	) {
		items.push({
			kind: 'earlier-boundary',
			key: key('prefix:earlier-boundary'),
			spacingAfter: 'none',
		});
	}
	const transcriptStartIndex = items.length;
	items.push(...presentedBody);
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
	const memberRowIdByDomAnchorId = new Map<string, string>();
	const representativeRowIdByKey = new Map<string, string>();
	const collapsedGroupByMemberRowId = new Map<string, ToolGroupVirtualFeedItem>();
	for (const [index, virtualItem] of items.entries()) {
		if (indexByKey.has(virtualItem.key)) {
			throw new Error(`Duplicate conversation feed key: ${virtualItem.key}`);
		}
		indexByKey.set(virtualItem.key, index);
		if (virtualItem.kind === 'tool-group') {
			representativeRowIdByKey.set(virtualItem.key, virtualItem.members[0].item.id);
			if (virtualItem.expanded) continue;
			for (const member of virtualItem.members) {
				collapsedGroupByMemberRowId.set(member.item.id, virtualItem);
				indexByRowId.set(member.item.id, index);
				targetByDomAnchorId.set(member.item.id, {
					index,
					innerRowId: virtualItem.anchorId,
				});
				memberRowIdByDomAnchorId.set(member.item.id, member.item.id);
				for (const anchorId of toolAnchorIds(member.item)) {
					targetByDomAnchorId.set(anchorId, {
						index,
						innerRowId: virtualItem.anchorId,
					});
					memberRowIdByDomAnchorId.set(anchorId, member.item.id);
				}
			}
		} else if (virtualItem.kind === 'transcript') {
			representativeRowIdByKey.set(virtualItem.key, virtualItem.item.id);
			indexByRowId.set(virtualItem.item.id, index);
			targetByDomAnchorId.set(virtualItem.item.id, {
				index,
				innerRowId: virtualItem.item.id,
			});
			memberRowIdByDomAnchorId.set(virtualItem.item.id, virtualItem.item.id);
			for (const anchorId of toolAnchorIds(virtualItem.item)) {
				targetByDomAnchorId.set(anchorId, { index, innerRowId: virtualItem.item.id });
				memberRowIdByDomAnchorId.set(anchorId, virtualItem.item.id);
			}
		}
	}

	return {
		items,
		indexByKey,
		indexByRowId,
		targetByDomAnchorId,
		memberRowIdByDomAnchorId,
		representativeRowIdByKey,
		collapsedGroupByMemberRowId,
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
	const memberRowIdByDomAnchorId = new Map(model.memberRowIdByDomAnchorId);
	const representativeRowIdByKey = new Map(model.representativeRowIdByKey);
	for (let index = insertIndex; index < items.length; index += 1) {
		indexByKey.set(items[index].key, index);
	}
	for (const [offset, virtualItem] of appendedVirtualItems.entries()) {
		if (virtualItem.kind !== 'transcript') continue;
		const index = insertIndex + offset;
		representativeRowIdByKey.set(virtualItem.key, virtualItem.item.id);
		indexByRowId.set(virtualItem.item.id, index);
		targetByDomAnchorId.set(virtualItem.item.id, {
			index,
			innerRowId: virtualItem.item.id,
		});
		memberRowIdByDomAnchorId.set(virtualItem.item.id, virtualItem.item.id);
		for (const anchorId of toolAnchorIds(virtualItem.item)) {
			targetByDomAnchorId.set(anchorId, { index, innerRowId: virtualItem.item.id });
			memberRowIdByDomAnchorId.set(anchorId, virtualItem.item.id);
		}
	}

	return {
		...model,
		items,
		indexByKey,
		indexByRowId,
		targetByDomAnchorId,
		memberRowIdByDomAnchorId,
		representativeRowIdByKey,
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
	if (item.kind === 'tool-group') {
		return 24 + (item.spacingAfter === 'transcript' ? 12 : 0);
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
