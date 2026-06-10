import type { ChatOrderList } from '$lib/api/chats.js';
import type { DropTargetRecord } from '@atlaskit/pragmatic-drag-and-drop/types';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

const sidebarChatDragKey = Symbol('sidebar-chat-drag');
const splitPaneChatDragKey = Symbol('split-pane-chat-drag');
const sidebarChatDropTargetKey = Symbol('sidebar-chat-drop-target');

export interface SidebarChatDragData {
	[sidebarChatDragKey]: true;
	[splitPaneChatDragKey]: true;
	kind: 'sidebar-chat';
	chatId: string;
	list: ChatOrderList;
	index: number;
	instanceId: symbol;
}

export interface SidebarChatDropTargetData {
	[sidebarChatDropTargetKey]: true;
	kind: 'sidebar-chat-row-target';
	chatId: string;
	list: ChatOrderList;
	index: number;
	instanceId: symbol;
}

export interface SidebarDropInstruction {
	sourceChatId: string;
	sourceList: ChatOrderList;
	targetChatId: string;
	targetList: ChatOrderList;
	closestEdge: Edge | null;
}

export function getSidebarChatDragData(input: {
	chatId: string;
	list: ChatOrderList;
	index: number;
	instanceId: symbol;
}): SidebarChatDragData {
	return {
		[sidebarChatDragKey]: true,
		[splitPaneChatDragKey]: true,
		kind: 'sidebar-chat',
		chatId: input.chatId,
		list: input.list,
		index: input.index,
		instanceId: input.instanceId,
	};
}

export function getSidebarChatDropTargetData(input: {
	chatId: string;
	list: ChatOrderList;
	index: number;
	instanceId: symbol;
}): SidebarChatDropTargetData {
	return {
		[sidebarChatDropTargetKey]: true,
		kind: 'sidebar-chat-row-target',
		chatId: input.chatId,
		list: input.list,
		index: input.index,
		instanceId: input.instanceId,
	};
}

function asDataRecord(data: unknown): Record<string | symbol, unknown> | null {
	if (typeof data !== 'object' || data === null) return null;
	return data as Record<string | symbol, unknown>;
}

export function isSidebarChatDragData(data: unknown): data is SidebarChatDragData {
	const record = asDataRecord(data);
	return record?.[sidebarChatDragKey] === true && record?.[splitPaneChatDragKey] === true;
}

export function isSidebarChatDropTargetData(data: unknown): data is SidebarChatDropTargetData {
	const record = asDataRecord(data);
	return record?.[sidebarChatDropTargetKey] === true;
}

export function sidebarDragCanReorder(
	source: SidebarChatDragData,
	target: SidebarChatDropTargetData,
): boolean {
	return (
		source.instanceId === target.instanceId &&
		source.list === target.list &&
		source.chatId !== target.chatId
	);
}

export function findSidebarDropTarget(
	dropTargets: DropTargetRecord[],
): SidebarChatDropTargetData | null {
	for (const target of dropTargets) {
		if (isSidebarChatDropTargetData(target.data)) return target.data;
	}
	return null;
}
