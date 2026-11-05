import type { GroupDescriptor, MemberWindowRequest } from '$shared/transcript-display-contract';
import { isHandoffSummaryNoticeDetail, isInterAgentMessageOutcomeNoticeDetail, isInterAgentMessageReceivedNoticeDetail } from '$shared/transcript-notice-details';
import type { PendingPermissionRequest } from '$lib/types/chat';
import type { ConversationFeedRenderItem, ConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
import type { ChatDisplayRow } from '$lib/chat/transcript/transcript-row-projection.js';
import { descriptorLast, expansionFor, type DisplayWindowSnapshot } from '$lib/chat/transcript/display-window-controller.js';

export type ConversationFeedSpacing = 'responsive-feed' | 'transcript' | 'none';
export type ConversationEarlierBoundaryMode = 'hidden' | 'visible' | 'when-collapsed';
export type TranscriptVirtualFeedItem = { kind: 'transcript'; key: string; item: ConversationFeedRenderItem; spacingAfter: ConversationFeedSpacing };
export type ToolGroupVirtualFeedItem = {
	kind: 'tool-group'; key: string; anchorId: string; descriptor: GroupDescriptor; expanded: boolean; spacingAfter: ConversationFeedSpacing;
};
export type ConversationVirtualFeedItem =
	| { kind: 'viewport-start-spacer' | 'refresh-error' | 'earlier-boundary' | 'later-boundary' | 'retained-gap'; key: string; spacingAfter: 'none' }
	| TranscriptVirtualFeedItem
	| ToolGroupVirtualFeedItem
	| { kind: 'member-boundary'; key: string; group: GroupDescriptor; anchor: MemberWindowRequest['anchor']; remaining: number; spacingAfter: 'none' }
	| { kind: 'permission'; key: string; request: PendingPermissionRequest; leadingSpacing: boolean; spacingAfter: 'responsive-feed' | 'none' }
	| { kind: 'viewport-end-spacer'; key: string; reserveComposerCapSpace: boolean; spacingAfter: 'none' };

export interface ConversationVirtualTarget { index: number; innerRowId: string }
export interface ConversationVirtualFeedModel {
	items: ConversationVirtualFeedItem[];
	transcriptViewId: string;
	indexByKey: Map<string, number>;
	indexByRowId: Map<string, number>;
	targetByDomAnchorId: Map<string, ConversationVirtualTarget>;
	representativeRowIdByKey: Map<string, string>;
	transcriptStartIndex: number;
	transcriptEndIndex: number;
}
export interface ConversationVirtualFeedInput {
	showRefreshError: boolean;
	earlierBoundary: ConversationEarlierBoundaryMode;
	showLaterBoundary: boolean;
	reserveComposerCapSpace: boolean;
	surfaceIdentity: string;
	transcriptViewId: string;
	display: DisplayWindowSnapshot;
	renderModel: ConversationFeedRenderModel;
	overlays: readonly ChatDisplayRow[];
	optimisticAfterOrdinals: ReadonlyMap<string, number>;
	pendingPermissions: readonly PendingPermissionRequest[];
}

export function groupContainingRow(model: ConversationVirtualFeedModel, rowId: string): ToolGroupVirtualFeedItem | undefined {
	const prefix = `${model.transcriptViewId}:`;
	if (!rowId.startsWith(prefix)) return undefined;
	const ordinal = Number(rowId.slice(prefix.length));
	if (!Number.isSafeInteger(ordinal) || model.indexByRowId.has(rowId)) return undefined;
	return model.items.find((item): item is ToolGroupVirtualFeedItem => item.kind === 'tool-group'
		&& ordinal >= item.descriptor.firstMember && ordinal <= item.descriptor.lastMember);
}

export function buildConversationVirtualFeedModel(input: ConversationVirtualFeedInput): ConversationVirtualFeedModel {
	const items: ConversationVirtualFeedItem[] = [];
	const key = (local: string) => JSON.stringify([input.surfaceIdentity, local]);
	const rowId = (ordinal: number) => `${input.transcriptViewId}:${ordinal}`;
	const window = input.display.window;
	const renderByOrdinal = new Map(input.renderModel.items.flatMap(item => item.kind === 'message' && item.ordinal !== undefined ? [[item.ordinal, item] as const] : []));
	const rendered = new Set<string>();
	const pushRow = (item: ConversationFeedRenderItem) => {
		if (rendered.has(item.id)) return;
		rendered.add(item.id);
		items.push({ kind: 'transcript', key: key(`transcript:${item.id}`), item, spacingAfter: 'transcript' });
	};
	const retained = input.display.protectedRows.map(row => renderByOrdinal.get(row.detail.ordinal)).filter((row): row is NonNullable<typeof row> => !!row).sort((a, b) => a.ordinal! - b.ordinal!);
	const insertRetained = (through: number) => {
		for (const row of retained) {
			if (row.ordinal! > through || rendered.has(row.id)) continue;
			// Retained islands have no completeness certificate for their intervening spans.
			if (items.at(-1)?.kind !== 'retained-gap') items.push({ kind: 'retained-gap', key: key(`retained:before:${row.id}`), spacingAfter: 'none' });
			pushRow(row);
			items.push({ kind: 'retained-gap', key: key(`retained:after:${row.id}`), spacingAfter: 'none' });
		}
	};
	items.push({ kind: 'viewport-start-spacer', key: key('prefix:viewport-start-spacer'), spacingAfter: 'none' });
	if (input.showRefreshError) items.push({ kind: 'refresh-error', key: key('prefix:refresh-error'), spacingAfter: 'none' });
	if (window) insertRetained(window.interval.after);
	if (input.earlierBoundary === 'visible' || input.earlierBoundary === 'when-collapsed'
		&& window?.items.some(item => item.kind === 'tool-group' && !expansionFor(item, input.display.expansions))) {
		items.push({ kind: 'earlier-boundary', key: key('prefix:earlier-boundary'), spacingAfter: 'none' });
	}
	const transcriptStartIndex = items.length;
	const represented = new Set(window?.items.flatMap(item => item.kind === 'row' && item.permissionOccurrenceId && renderByOrdinal.has(item.ordinal) ? [item.permissionOccurrenceId] : []) ?? []);
	const permissions = input.pendingPermissions.filter(request => {
		if (represented.has(request.permissionOccurrenceId)) return false;
		const plan = request.planReference;
		return !plan || plan.serverInstanceId !== window?.certificate.serverInstanceId
			|| plan.chatId !== window.certificate.chatId || plan.transcriptViewId !== input.transcriptViewId
			|| !window.items.some(item => item.kind === 'row' && item.ordinal === plan.ordinal && renderByOrdinal.has(item.ordinal));
	});
	const overlays = input.overlays.filter(row => row.kind === 'message');
	const inserted = new Set<string>();
	const placements = new Map(window?.cutPlacements.map(cut => [cut.id, cut.placement]));
	const insertOverlays = (through: number) => {
		for (const overlay of overlays) {
			if (inserted.has(overlay.id) || placements.get(overlay.id) !== 'inline') continue;
			const ordinal = input.optimisticAfterOrdinals.get(overlay.id.slice('optimistic:'.length));
			if (ordinal === undefined || ordinal > through) continue;
			pushRow({ ...overlay, index: items.length, layout: 'standard' });
			inserted.add(overlay.id);
		}
		for (const permission of permissions) {
			const id = `permission:${permission.permissionOccurrenceId}`;
			if (inserted.has(id) || placements.get(id) !== 'inline' || (permission.transcript?.afterOrdinal ?? Infinity) > through) continue;
			items.push({ kind: 'permission', key: key(id), request: permission, leadingSpacing: true, spacingAfter: 'responsive-feed' });
			inserted.add(id);
		}
	};
	if (window) insertOverlays(window.interval.after);
	for (const descriptor of window?.items ?? []) {
		insertRetained(descriptor.kind === 'row' ? descriptor.ordinal - 1 : descriptor.firstMember - 1);
		if (descriptor.kind === 'row') {
			const item = renderByOrdinal.get(descriptor.ordinal);
			if (item) pushRow(item);
		} else {
			const expansion = expansionFor(descriptor, input.display.expansions);
			const anchorId = `tool-group:${rowId(descriptor.firstMember)}`;
			items.push({ kind: 'tool-group', key: key(`${window!.certificate.profileKey}:${window!.certificate.cutsKey}:${anchorId}`), anchorId,
				descriptor, expanded: !!expansion, spacingAfter: expansion ? 'none' : 'transcript' });
			if (expansion) {
				const page = expansion.page;
				insertRetained((page.ordinals[0] ?? descriptor.firstMember) - 1);
				if (page.earlier) items.push({ kind: 'member-boundary', key: key(`${anchorId}:earlier`), group: descriptor,
					anchor: { kind: 'before', ordinal: page.earlier.beforeOrdinal }, remaining: page.earlier.remaining, spacingAfter: 'none' });
				for (const ordinal of page.ordinals) { insertRetained(ordinal); const item = renderByOrdinal.get(ordinal); if (item) pushRow(item); }
				if (page.later) items.push({ kind: 'member-boundary', key: key(`${anchorId}:later`), group: descriptor,
					anchor: { kind: 'after', ordinal: page.later.afterOrdinal }, remaining: page.later.remaining, spacingAfter: 'none' });
			}
		}
		insertRetained(descriptorLast(descriptor));
		insertOverlays(descriptor.kind === 'tool-group' ? descriptor.fragment.through : descriptorLast(descriptor));
	}
	const transcriptEndIndex = items.length;
	if (input.showLaterBoundary) items.push({ kind: 'later-boundary', key: key('suffix:later-boundary'), spacingAfter: 'none' });
	insertRetained(Infinity);
	for (const overlay of overlays) if (!inserted.has(overlay.id)) pushRow({ ...overlay, index: items.length, layout: 'standard' });
	for (const notice of input.overlays) if (notice.kind === 'local-notice') pushRow({ kind: 'local-notice', id: notice.id, notice, index: items.length });
	const detached = permissions.filter(request => !inserted.has(`permission:${request.permissionOccurrenceId}`));
	for (const [index, request] of detached.entries()) {
		const id = `permission:${request.permissionOccurrenceId}`;
		items.push({ kind: 'permission', key: key(id), request, leadingSpacing: index === 0,
			spacingAfter: index < detached.length - 1 ? 'responsive-feed' : 'none' });
	}
	items.push({ kind: 'viewport-end-spacer', key: key('suffix:viewport-end-spacer'), reserveComposerCapSpace: input.reserveComposerCapSpace, spacingAfter: 'none' });
	const model: ConversationVirtualFeedModel = { items, transcriptViewId: input.transcriptViewId, indexByKey: new Map(), indexByRowId: new Map(),
		targetByDomAnchorId: new Map(), representativeRowIdByKey: new Map(), transcriptStartIndex, transcriptEndIndex };
	for (const [index, item] of items.entries()) {
		if (model.indexByKey.has(item.key)) throw new Error('Duplicate display key');
		model.indexByKey.set(item.key, index);
		if (item.kind === 'tool-group') {
			model.representativeRowIdByKey.set(item.key, rowId(item.descriptor.firstMember));
			model.targetByDomAnchorId.set(item.anchorId, { index, innerRowId: item.anchorId });
		} else if (item.kind === 'transcript') {
			model.representativeRowIdByKey.set(item.key, item.item.id);
			model.indexByRowId.set(item.item.id, index);
			model.targetByDomAnchorId.set(item.item.id, { index, innerRowId: item.item.id });
		}
	}
	return model;
}

export function estimateConversationFeedItemSize(item: ConversationVirtualFeedItem | undefined): number {
	if (!item) return 120;
	if (item.kind === 'viewport-start-spacer') return 16;
	if (item.kind === 'viewport-end-spacer') return item.reserveComposerCapSpace ? 56 : 16;
	if (item.kind === 'permission') return 240 + (item.leadingSpacing ? 8 : 0) + (item.spacingAfter === 'responsive-feed' ? 12 : 0);
	if (item.kind === 'tool-group') return item.expanded ? 24 : 36;
	if (item.kind === 'retained-gap') return 24;
	if (item.kind !== 'transcript') return 44;
	if (item.item.kind === 'local-notice') return 64;
	if (item.item.layout === 'permission') return 252;
	const message = item.item.message;
	switch (message.type) {
		case 'transcript-notice':
			if (isInterAgentMessageOutcomeNoticeDetail(message.detail)) return 242 + Math.max(0, message.detail.results.length - 1) * 26;
			if (isInterAgentMessageReceivedNoticeDetail(message.detail) || isHandoffSummaryNoticeDetail(message.detail)) return 242;
			return 64;
		case 'user-message': return message.presentation?.style ? 156 : 124;
		case 'assistant-message': return 192;
		case 'thinking': return 172;
		case 'cli-row': return 124;
		default: return 108;
	}
}
