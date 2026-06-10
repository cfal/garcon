import type { ChatOrderList } from '$lib/api/chats.js';
import type { DropTargetRecord } from '@atlaskit/pragmatic-drag-and-drop/types';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

const sidebarChatDragKind = 'sidebar-chat';
const splitPaneChatDragKind = 'split-pane-chat';
const sidebarChatDropTargetKind = 'sidebar-chat-row-target';
const chatOrderLists: ChatOrderList[] = ['pinned', 'normal', 'archived'];

export interface SidebarChatDragData {
	kind: typeof sidebarChatDragKind;
	splitPaneDragKind: typeof splitPaneChatDragKind;
	chatId: string;
	list: ChatOrderList;
	index: number;
	instanceId: symbol;
}

export interface SidebarChatDropTargetData {
	kind: typeof sidebarChatDropTargetKind;
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
		kind: sidebarChatDragKind,
		splitPaneDragKind: splitPaneChatDragKind,
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
		kind: sidebarChatDropTargetKind,
		chatId: input.chatId,
		list: input.list,
		index: input.index,
		instanceId: input.instanceId,
	};
}

function asDataRecord(data: unknown): Record<string, unknown> | null {
	if (typeof data !== 'object' || data === null) return null;
	return data as Record<string, unknown>;
}

function isChatOrderList(value: unknown): value is ChatOrderList {
	return typeof value === 'string' && chatOrderLists.includes(value as ChatOrderList);
}

export function isSidebarChatDragData(data: unknown): data is SidebarChatDragData {
	const record = asDataRecord(data);
	return (
		record?.kind === sidebarChatDragKind &&
		record.splitPaneDragKind === splitPaneChatDragKind &&
		typeof record.chatId === 'string' &&
		isChatOrderList(record.list) &&
		typeof record.index === 'number' &&
		typeof record.instanceId === 'symbol'
	);
}

export function isSidebarChatDropTargetData(data: unknown): data is SidebarChatDropTargetData {
	const record = asDataRecord(data);
	return (
		record?.kind === sidebarChatDropTargetKind &&
		typeof record.chatId === 'string' &&
		isChatOrderList(record.list) &&
		typeof record.index === 'number' &&
		typeof record.instanceId === 'symbol'
	);
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

export function resolveSidebarDropInstruction(
	sourceData: unknown,
	dropTargets: DropTargetRecord[],
): SidebarDropInstruction | null {
	if (!isSidebarChatDragData(sourceData)) return null;
	for (const target of dropTargets) {
		const targetData = target.data;
		if (!isSidebarChatDropTargetData(targetData)) continue;
		if (!sidebarDragCanReorder(sourceData, targetData)) return null;
		return {
			sourceChatId: sourceData.chatId,
			sourceList: sourceData.list,
			targetChatId: targetData.chatId,
			targetList: targetData.list,
			closestEdge: extractClosestEdge(target.data),
		};
	}
	return null;
}
