import { isToolUseMessage, ToolResultMessage } from '$shared/chat-types';
import {
	isHandoffSummaryNoticeDetail,
	isInterAgentMessageOutcomeNoticeDetail,
	isInterAgentMessageReceivedNoticeDetail,
} from '$shared/transcript-notice-details';
import type { PendingPermissionRequest } from '$lib/types/chat';
import type { ConversationViewportTarget } from '$lib/chat/transcript/conversation-viewport-port.js';
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
			reserveComposerCapSpace: boolean;
			spacingAfter: 'none';
	  };

interface ConversationVirtualTarget {
	index: number;
	innerRowId: string;
	collapsedMemberRowId?: string;
}

export interface ConversationVirtualFeedModel {
	items: ConversationVirtualFeedItem[];
	indexByKey: Map<string, number>;
	indexByRowId: Map<string, number>;
	rowIdByToolAnchorId: ReadonlyMap<string, string>;
	transcriptStartIndex: number;
	transcriptEndIndex: number;
}

export interface ConversationVirtualFeedInput {
	showRefreshError: boolean;
	earlierBoundary: ConversationEarlierBoundaryMode;
	showLaterBoundary: boolean;
	reserveComposerCapSpace: boolean;
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

function toolAnchorId(item: ConversationFeedRenderItem): string | undefined {
	if (item.kind !== 'message') return;
	if (isToolUseMessage(item.message)) {
		return `tool-input-${item.message.toolId}`;
	}
	if (item.message instanceof ToolResultMessage) {
		return `tool-result-${item.id}`;
	}
}

export function resolveConversationVirtualTarget(
	model: ConversationVirtualFeedModel,
	target: ConversationViewportTarget,
): ConversationVirtualTarget | undefined {
	const rowId = target.kind === 'dom-anchor'
		? model.rowIdByToolAnchorId.get(target.id) ?? target.id
		: target.id;
	const index = model.indexByRowId.get(rowId);
	if (index === undefined) return undefined;
	const item = model.items[index];
	if (item.kind !== 'tool-group') return { index, innerRowId: rowId };
	if (target.kind === 'presentation-row') return { index, innerRowId: item.anchorId };
	return {
		index,
		innerRowId: target.kind === 'row' ? rowId : item.anchorId,
		collapsedMemberRowId: rowId,
	};
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
		if (expanded) {
			for (const item of run) grouped.push(item);
		}
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
	for (const item of presentedBody) items.push(item);
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
		reserveComposerCapSpace: input.reserveComposerCapSpace,
		spacingAfter: 'none',
	});

	return indexConversationItems(items, transcriptStartIndex, transcriptEndIndex);
}

function indexConversationItems(
	items: ConversationVirtualFeedItem[],
	transcriptStartIndex: number,
	transcriptEndIndex: number,
	tail?: { previous: ConversationVirtualFeedModel; from: number },
): ConversationVirtualFeedModel {
	// An append retains every member. Only a growing tail group and the suffix need new targets.
	const indexByKey = new Map(tail?.previous.indexByKey);
	const indexByRowId = new Map(tail?.previous.indexByRowId);
	const previousAliases = tail?.previous.rowIdByToolAnchorId;
	let changedAliases: Map<string, string> | undefined;
	function indexRow(item: ConversationFeedRenderItem, index: number): void {
		indexByRowId.set(item.id, index);
		const alias = toolAnchorId(item);
		if (alias === undefined && !(changedAliases ?? previousAliases)?.has(item.id)) return;
		changedAliases ??= new Map(previousAliases);
		// When an alias coincides with a row ID the last indexed occurrence owns that DOM target.
		changedAliases.delete(item.id);
		if (alias !== undefined) changedAliases.set(alias, item.id);
	}
	if (tail) {
		for (let index = tail.from; index < tail.previous.items.length; index++) {
			indexByKey.delete(tail.previous.items[index].key);
		}
	}
	for (let index = tail?.from ?? 0; index < items.length; index++) {
		const virtualItem = items[index];
		if (indexByKey.has(virtualItem.key)) {
			throw new Error(`Duplicate conversation feed key: ${virtualItem.key}`);
		}
		indexByKey.set(virtualItem.key, index);
		if (virtualItem.kind === 'tool-group') {
			if (virtualItem.expanded) continue;
			for (const member of virtualItem.members) indexRow(member.item, index);
		} else if (virtualItem.kind === 'transcript') {
			indexRow(virtualItem.item, index);
		}
	}

	return {
		items,
		indexByKey,
		indexByRowId,
		rowIdByToolAnchorId: changedAliases ?? previousAliases ?? new Map(),
		transcriptStartIndex,
		transcriptEndIndex,
	};
}

function newTranscriptTail(
	model: ConversationVirtualFeedModel,
	surfaceIdentity: string,
	appendedItems: ConversationFeedRenderItem[],
): TranscriptVirtualFeedItem[] | null {
	if (appendedItems.length === 0) return null;
	const seen = new Set<string>();
	const tail: TranscriptVirtualFeedItem[] = [];
	for (const item of appendedItems) {
		if (model.indexByRowId.has(item.id) || seen.has(item.id)) return null;
		seen.add(item.id);
		tail.push({
			kind: 'transcript',
			key: namespacedKey(surfaceIdentity, `transcript:${item.id}`),
			item,
			spacingAfter: transcriptSpacing(item),
		});
	}
	return tail;
}

export function appendConversationVirtualTranscriptTail(
	model: ConversationVirtualFeedModel,
	surfaceIdentity: string,
	appendedItems: ConversationFeedRenderItem[],
): ConversationVirtualFeedModel | null {
	const appended = newTranscriptTail(model, surfaceIdentity, appendedItems);
	if (!appended) return null;
	const from = model.transcriptEndIndex;
	const items = model.items.slice(0, from).concat(appended, model.items.slice(from));
	return indexConversationItems(items, model.transcriptStartIndex, from + appended.length, { previous: model, from });
}

export function appendCombinedConversationTail(
	model: ConversationVirtualFeedModel,
	input: Pick<
		ConversationVirtualFeedInput,
		'surfaceIdentity' | 'expandedToolMemberIds' | 'protectedVirtualKeys' | 'earlierBoundary'
	>,
	appendedItems: ConversationFeedRenderItem[],
): { model: ConversationVirtualFeedModel; changedIndex: number } | null {
	const appendedVirtualItems = newTranscriptTail(model, input.surfaceIdentity, appendedItems);
	if (!appendedVirtualItems) return null;
	let changedIndex = model.transcriptEndIndex;
	if (groupableToolInput(appendedVirtualItems[0])) {
		while (changedIndex > model.transcriptStartIndex && groupableToolInput(model.items[changedIndex - 1])) {
			changedIndex -= 1;
		}
		if (model.items[changedIndex - 1]?.kind === 'tool-group') changedIndex -= 1;
	}
	const previousGroup = model.items[changedIndex];
	const members = previousGroup?.kind === 'tool-group' ? previousGroup.members : [];
	const grouped = groupToolRuns(
		[...members, ...appendedVirtualItems],
		(key) => namespacedKey(input.surfaceIdentity, key),
		input.expandedToolMemberIds,
		new Set(input.protectedVirtualKeys),
	);
	if (
		input.earlierBoundary === 'when-collapsed' &&
		!model.items.slice(0, model.transcriptStartIndex).some((item) => item.kind === 'earlier-boundary') &&
		grouped.some((item) => item.kind === 'tool-group' && !item.expanded)
	) return null;
	if (
		previousGroup?.kind === 'tool-group' &&
		grouped[0]?.kind === 'tool-group' &&
		previousGroup.expanded !== grouped[0].expanded
	) return null;
	const items = model.items.slice(0, changedIndex).concat(
		grouped,
		model.items.slice(model.transcriptEndIndex),
	);
	return {
		model: indexConversationItems(items, model.transcriptStartIndex, changedIndex + grouped.length, {
			previous: model, from: changedIndex,
		}),
		changedIndex,
	};
}

export function estimateConversationFeedItemSize(
	item: ConversationVirtualFeedItem | undefined,
): number {
	if (!item) return 120;
	if (item.kind === 'viewport-start-spacer') return 16;
	if (item.kind === 'viewport-end-spacer') return item.reserveComposerCapSpace ? 56 : 16;
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
