import type { SidebarVirtualRow } from '$lib/sidebar/display/sidebar-virtual-chat-list';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import {
	closestEdgeForRow,
	mountedRowAtPoint,
	mountedVirtualItemAtPoint,
	pointIsInsideViewport,
} from './sidebar-chat-list-dom';
import {
	getSidebarChatDropTargetData,
	resolveSidebarDropInstructionForTarget,
	type SidebarChatDragData,
	type SidebarDropInstruction,
} from './sidebar-pragmatic-dnd';

export type SidebarPointDropContext =
	| { kind: 'outside' }
	| { kind: 'empty' }
	| { kind: 'source-row' }
	| { kind: 'compatible-row'; instruction: SidebarDropInstruction }
	| { kind: 'blocked-row' }
	| { kind: 'blocked-item' };

export function sidebarPointDropContext(
	viewport: HTMLElement | null,
	instanceId: symbol,
	source: SidebarChatDragData,
	clientX: number,
	clientY: number,
	rows: readonly SidebarVirtualRow[],
): SidebarPointDropContext {
	if (!viewport || !pointIsInsideViewport(viewport, clientX, clientY)) return { kind: 'outside' };
	const virtualItem = mountedVirtualItemAtPoint(clientX, clientY);
	const row = mountedRowAtPoint(clientX, clientY);
	if (!row) return virtualItem ? { kind: 'blocked-item' } : { kind: 'empty' };
	const chatId = row.dataset.sidebarVirtualRow;
	const list = row.dataset.sidebarVirtualListRow;
	const reorderScopeKey = row.dataset.sidebarVirtualReorderScope;
	if (
		!chatId ||
		!reorderScopeKey ||
		(list !== 'pinned' && list !== 'normal' && list !== 'archived')
	)
		return { kind: 'blocked-row' };
	let target = getSidebarChatDropTargetData({
		chatId,
		list,
		reorderScopeKey,
		instanceId,
		index: -1,
	});
	let closestEdge: Edge | null;
	if (reorderScopeKey !== source.reorderScopeKey) {
		const peer = rows.find(
			(candidate) =>
				candidate.type === 'chat' &&
				candidate.reorderScopeKey === source.reorderScopeKey &&
				candidate.reorderScopeIds.includes(candidate.chat.id) &&
				candidate.branch?.containsChat(chatId),
		);
		if (peer?.type !== 'chat') return { kind: 'blocked-row' };
		if (peer.chat.id === source.chatId) return { kind: 'source-row' };
		target = {
			...target,
			chatId: peer.chat.id,
			list: peer.list,
			reorderScopeKey: peer.reorderScopeKey,
		};
		closestEdge = 'bottom';
	} else {
		if (chatId === source.chatId && list === source.list) return { kind: 'source-row' };
		closestEdge = closestEdgeForRow(row, clientY);
	}
	const instruction = resolveSidebarDropInstructionForTarget({
		source,
		target,
		closestEdge,
	});
	return instruction ? { kind: 'compatible-row', instruction } : { kind: 'blocked-row' };
}

export function sidebarFallbackDropInstruction(
	source: SidebarChatDragData,
	context: SidebarPointDropContext,
	fallback: SidebarDropInstruction | null,
	rows: readonly SidebarVirtualRow[],
): SidebarDropInstruction | null {
	if (context.kind === 'compatible-row') return context.instruction;
	if (
		!fallback ||
		fallback.sourceChatId !== source.chatId ||
		fallback.sourceList !== source.list ||
		fallback.sourceScopeKey !== source.reorderScopeKey
	)
		return null;
	if (context.kind === 'empty') return fallback;
	if (context.kind !== 'source-row') return null;
	// A preview can move the source under the pointer; only peer roots establish adjacency.
	const peers = rows.flatMap((row) =>
		row.type === 'chat' && row.reorderScopeKey === source.reorderScopeKey ? [row.chat.id] : [],
	);
	const sourceIndex = peers.indexOf(source.chatId);
	const targetIndex = peers.indexOf(fallback.targetChatId);
	if (sourceIndex < 0 || targetIndex < 0) return null;
	switch (fallback.closestEdge) {
		case 'top':
			return sourceIndex === targetIndex - 1 ? fallback : null;
		case 'bottom':
			return sourceIndex === targetIndex + 1 ? fallback : null;
		default:
			return Math.abs(sourceIndex - targetIndex) === 1 ? fallback : null;
	}
}
