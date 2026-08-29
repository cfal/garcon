import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';
import type { DropTargetRecord } from '@atlaskit/pragmatic-drag-and-drop/types';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';

const sidebarChatDragKind = 'sidebar-chat';
const sidebarChatDropTargetKind = 'sidebar-chat-row-target';
const chatOrderLists: PersistedChatOrderGroup[] = ['pinned', 'normal', 'archived'];

export interface SidebarChatDragData extends Record<string | symbol, unknown> {
	kind: typeof sidebarChatDragKind;
	chatId: string;
	list: PersistedChatOrderGroup;
	index: number;
	instanceId: symbol;
	reorderScopeKey: string;
}

export interface SidebarChatDropTargetData extends Record<string | symbol, unknown> {
	kind: typeof sidebarChatDropTargetKind;
	chatId: string;
	list: PersistedChatOrderGroup;
	index: number;
	instanceId: symbol;
	reorderScopeKey: string;
}

export interface SidebarDropInstruction {
	sourceChatId: string;
	sourceList: PersistedChatOrderGroup;
	sourceScopeKey: string;
	targetChatId: string;
	targetList: PersistedChatOrderGroup;
	closestEdge: Edge | null;
}

export function getSidebarChatDragData(input: {
	chatId: string;
	list: PersistedChatOrderGroup;
	index: number;
	instanceId: symbol;
	reorderScopeKey: string;
}): SidebarChatDragData {
	return {
		kind: sidebarChatDragKind,
		chatId: input.chatId,
		list: input.list,
		index: input.index,
		instanceId: input.instanceId,
		reorderScopeKey: input.reorderScopeKey,
	};
}

export function getSidebarChatDropTargetData(input: {
	chatId: string;
	list: PersistedChatOrderGroup;
	index: number;
	instanceId: symbol;
	reorderScopeKey: string;
}): SidebarChatDropTargetData {
	return {
		kind: sidebarChatDropTargetKind,
		chatId: input.chatId,
		list: input.list,
		index: input.index,
		instanceId: input.instanceId,
		reorderScopeKey: input.reorderScopeKey,
	};
}

function asDataRecord(data: unknown): Record<string, unknown> | null {
	if (typeof data !== 'object' || data === null) return null;
	return data as Record<string, unknown>;
}

function isChatOrderList(value: unknown): value is PersistedChatOrderGroup {
	return typeof value === 'string' && chatOrderLists.includes(value as PersistedChatOrderGroup);
}

export function isSidebarChatDragData(data: unknown): data is SidebarChatDragData {
	const record = asDataRecord(data);
	return (
		record?.kind === sidebarChatDragKind &&
		typeof record.chatId === 'string' &&
		isChatOrderList(record.list) &&
		typeof record.index === 'number' &&
		typeof record.instanceId === 'symbol' &&
		typeof record.reorderScopeKey === 'string'
	);
}

export function isSidebarChatDropTargetData(data: unknown): data is SidebarChatDropTargetData {
	const record = asDataRecord(data);
	return (
		record?.kind === sidebarChatDropTargetKind &&
		typeof record.chatId === 'string' &&
		isChatOrderList(record.list) &&
		typeof record.index === 'number' &&
		typeof record.instanceId === 'symbol' &&
		typeof record.reorderScopeKey === 'string'
	);
}

export function sidebarDragCanReorder(
	source: SidebarChatDragData,
	target: SidebarChatDropTargetData,
): boolean {
	return (
		source.instanceId === target.instanceId &&
		source.list === target.list &&
		source.reorderScopeKey === target.reorderScopeKey &&
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

export function resolveSidebarDropInstructionForTarget(input: {
	source: SidebarChatDragData;
	target: SidebarChatDropTargetData;
	closestEdge: Edge | null;
}): SidebarDropInstruction | null {
	if (!sidebarDragCanReorder(input.source, input.target)) return null;
	return {
		sourceChatId: input.source.chatId,
		sourceList: input.source.list,
		sourceScopeKey: input.source.reorderScopeKey,
		targetChatId: input.target.chatId,
		targetList: input.target.list,
		closestEdge: input.closestEdge,
	};
}

export function resolveSidebarDropInstruction(
	sourceData: unknown,
	dropTargets: DropTargetRecord[],
): SidebarDropInstruction | null {
	if (!isSidebarChatDragData(sourceData)) return null;
	for (const target of dropTargets) {
		const targetData = target.data;
		if (!isSidebarChatDropTargetData(targetData)) continue;
		const instruction = resolveSidebarDropInstructionForTarget({
			source: sourceData,
			target: targetData,
			closestEdge: extractClosestEdge(target.data),
		});
		if (instruction) return instruction;
	}
	return null;
}
