import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import {
	MAX_WORKSPACE_WINDOWS,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
	type WorkspaceWindowTabState,
} from './surface-types.js';
import { collectWindowNodes } from './window-tree.js';

export interface WorkspaceWindowTabActionState {
	readonly surface: SurfaceDescriptor | null;
	readonly index: number;
	readonly canReorder: boolean;
	readonly canMoveBetweenWindows: boolean;
	readonly canMoveToNewWindow: boolean;
	readonly otherWindows: readonly WorkspaceWindowNode[];
}

export function resolveWorkspaceWindowTabActions(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
	tabs: WorkspaceWindowTabState,
	surfaceId: string,
): WorkspaceWindowTabActionState {
	const surface = snapshot.surfaces[surfaceId] ?? null;
	const index = tabs.order.indexOf(surfaceId);
	const canReorder = surface !== null && surface.type !== 'terminal-launcher' && index >= 0;
	const hasMovableChat = surface?.type !== 'chat' || Boolean(surface.chatId);
	const canMoveBetweenWindows = canReorder && hasMovableChat;
	const windows = collectWindowNodes(snapshot.desktopRoot);
	const canCreateWindow = windows.length < MAX_WORKSPACE_WINDOWS;
	return {
		surface,
		index,
		canReorder,
		canMoveBetweenWindows,
		canMoveToNewWindow:
			canCreateWindow &&
			canMoveBetweenWindows &&
			(surface?.type !== 'chat' || tabs.order.length > 1),
		otherWindows: canMoveBetweenWindows
			? windows.filter((workspaceWindow) => workspaceWindow.id !== windowId)
			: [],
	};
}

type MoveToNewWindowActionPort = Pick<WorkspaceCoordinator, 'layout' | 'moveTabToNewWindow'>;

export function moveWorkspaceTabToNewWindow(
	workspace: MoveToNewWindowActionPort,
	surfaceId: string,
	windowId: WorkspaceWindowId,
	edge: WorkspaceWindowEdge,
): Promise<unknown> {
	const surface = workspace.layout.surface(surfaceId);
	if (!surface || surface.type === 'terminal-launcher') return Promise.resolve();
	return workspace.moveTabToNewWindow(surfaceId, windowId, edge);
}
