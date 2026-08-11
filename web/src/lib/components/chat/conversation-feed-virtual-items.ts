import { isToolUseMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';
import type { ReconciledConversationFeedRenderItem } from '$lib/chat/transcript/conversation-feed-render-model.js';

export type ConversationFeedSpacing = 'responsive-feed' | 'scaled-transcript' | 'none';

export type ConversationVirtualFeedItem =
	| { kind: 'viewport-start-spacer'; key: string; spacingAfter: 'none' }
	| { kind: 'top-toolbar-spacer'; key: string; spacingAfter: 'none' }
	| { kind: 'refresh-error'; key: string; spacingAfter: 'none' }
	| { kind: 'earlier-boundary'; key: string; spacingAfter: 'none' }
	| {
			kind: 'transcript';
			key: string;
			item: ReconciledConversationFeedRenderItem;
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
	showTopToolbarSpacer: boolean;
	showRefreshError: boolean;
	showEarlierBoundary: boolean;
	showLaterBoundary: boolean;
	reserveComposerTraySpace: boolean;
	surfaceIdentity: string;
	transcriptGenerationId: string;
	transcriptItems: ReconciledConversationFeedRenderItem[];
	pendingPermissions: PendingPermissionRequest[];
}

function namespacedKey(surfaceIdentity: string, localKey: string): string {
	return JSON.stringify([surfaceIdentity, localKey]);
}

function toolMembers(
	item: ReconciledConversationFeedRenderItem,
): Array<{ rowId: string; toolId: string }> {
	if (item.kind === 'bash-group' || item.kind === 'read-group') {
		return item.rows.map((row) => ({ rowId: row.id, toolId: row.message.toolId }));
	}
	if (item.kind === 'message' && isToolUseMessage(item.message)) {
		return [{ rowId: item.rowIds[0], toolId: item.message.toolId }];
	}
	return [];
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

	if (input.showTopToolbarSpacer) {
		items.push({
			kind: 'top-toolbar-spacer',
			key: key('prefix:top-toolbar-spacer'),
			spacingAfter: 'none',
		});
	}
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
	const permissionByAnchor = new Map<number, PendingPermissionRequest[]>();
	const detachedPermissions: PendingPermissionRequest[] = [];
	for (const permission of input.pendingPermissions) {
		const anchor = permission.transcript;
		if (!anchor || anchor.generationId !== input.transcriptGenerationId) {
			detachedPermissions.push(permission);
			continue;
		}
		const anchored = permissionByAnchor.get(anchor.afterSeq) ?? [];
		anchored.push(permission);
		permissionByAnchor.set(anchor.afterSeq, anchored);
	}

	for (const [transcriptIndex, item] of input.transcriptItems.entries()) {
		const seqs = transcriptItemSequences(item);
		const anchored = seqs.flatMap((seq) => permissionByAnchor.get(seq) ?? []);
		for (const seq of seqs) permissionByAnchor.delete(seq);
		items.push({
			kind: 'transcript',
			key: key(`transcript:${item.virtualKey}`),
			item,
			spacingAfter:
				anchored.length === 0 && transcriptIndex < input.transcriptItems.length - 1
					? 'scaled-transcript'
					: 'none',
		});
		for (const [permissionIndex, request] of anchored.entries()) {
			items.push(permissionItem(key, request, permissionIndex === 0, (
				permissionIndex < anchored.length - 1 || transcriptIndex < input.transcriptItems.length - 1
			)));
		}
	}
	for (const permissions of permissionByAnchor.values()) detachedPermissions.push(...permissions);
	const transcriptEndIndex = items.length;

	if (input.showLaterBoundary) {
		items.push({
			kind: 'later-boundary',
			key: key('suffix:later-boundary'),
			spacingAfter: 'none',
		});
	}
	for (const [permissionIndex, request] of detachedPermissions.entries()) {
		items.push(permissionItem(
			key,
			request,
			permissionIndex === 0,
			permissionIndex < detachedPermissions.length - 1,
		));
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

		for (const rowId of virtualItem.item.rowIds) {
			indexByRowId.set(rowId, index);
			targetByDomAnchorId.set(rowId, { index, innerRowId: rowId });
		}
		for (const member of toolMembers(virtualItem.item)) {
			const target = { index, innerRowId: member.rowId };
			targetByDomAnchorId.set(`tool-input-${member.toolId}`, target);
			targetByDomAnchorId.set(`tool-result-${member.toolId}`, target);
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

function permissionItem(
	key: (localKey: string) => string,
	request: PendingPermissionRequest,
	leadingSpacing: boolean,
	trailingSpacing: boolean,
): ConversationVirtualFeedItem {
	return {
		kind: 'permission',
		key: key(`permission:${request.permissionRequestId}:${request.control?.incarnation ?? 'legacy'}`),
		request,
		leadingSpacing,
		spacingAfter: trailingSpacing ? 'responsive-feed' : 'none',
	};
}

function transcriptItemSequences(item: ReconciledConversationFeedRenderItem): number[] {
	if (item.kind === 'message') return item.seq === undefined ? [] : [item.seq];
	if (item.kind === 'bash-group' || item.kind === 'read-group') {
		return item.rows.flatMap((row) => row.seq === undefined ? [] : [row.seq]);
	}
	return [];
}

export function appendConversationVirtualTranscriptTail(
	model: ConversationVirtualFeedModel,
	surfaceIdentity: string,
	appendedItems: ReconciledConversationFeedRenderItem[],
): ConversationVirtualFeedModel | null {
	if (appendedItems.length === 0 || appendedItems.some((item) => item.rowIds.length !== 1)) {
		return null;
	}
	const insertIndex = model.transcriptEndIndex;
	const appendedVirtualItems = appendedItems.map((item, index): ConversationVirtualFeedItem => ({
		kind: 'transcript',
		key: namespacedKey(surfaceIdentity, `transcript:${item.virtualKey}`),
		item,
		spacingAfter: index < appendedItems.length - 1 ? 'scaled-transcript' : 'none',
	}));
	if (appendedVirtualItems.some((item) => model.indexByKey.has(item.key))) return null;

	const items = model.items.slice();
	if (insertIndex > model.transcriptStartIndex) {
		const priorTail = items[insertIndex - 1];
		if (priorTail?.kind !== 'transcript') return null;
		items[insertIndex - 1] = { ...priorTail, spacingAfter: 'scaled-transcript' };
	}
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
		for (const rowId of virtualItem.item.rowIds) {
			indexByRowId.set(rowId, index);
			targetByDomAnchorId.set(rowId, { index, innerRowId: rowId });
		}
		for (const member of toolMembers(virtualItem.item)) {
			const target = { index, innerRowId: member.rowId };
			targetByDomAnchorId.set(`tool-input-${member.toolId}`, target);
			targetByDomAnchorId.set(`tool-result-${member.toolId}`, target);
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
	textScale: number,
): number {
	if (!item) return 120;
	if (item.kind === 'viewport-start-spacer') return 16;
	if (item.kind === 'viewport-end-spacer') return item.reserveComposerTraySpace ? 56 : 16;
	if (item.kind === 'top-toolbar-spacer') return 48;
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
	const scale = Math.max(0.5, Math.min(textScale, 2));
	const spacing = item.spacingAfter === 'scaled-transcript' ? 12 * scale : 0;
	if (renderItem.kind === 'local-notice') return 52 * scale + spacing;
	if (renderItem.kind === 'bash-group' || renderItem.kind === 'read-group') {
		return (44 + renderItem.rows.length * 34) * scale + spacing;
	}
	if (renderItem.message.type === 'user-message') return 112 * scale + spacing;
	if (renderItem.message.type === 'assistant-message') return 180 * scale + spacing;
	if (renderItem.message.type === 'thinking') return 160 * scale + spacing;
	return 96 * scale + spacing;
}
