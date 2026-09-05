import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import {
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
	type WorkspaceWindowTabState,
} from './surface-types.js';
import { collectWindowNodes } from './window-tree.js';
import {
	mapWorkspaceSplitAdmissions,
	type WorkspaceSplitAdmission,
	type WorkspaceSplitAdmissions,
} from './window-geometry-policy.js';

export interface WorkspaceWindowTabActionState {
	readonly surface: SurfaceDescriptor | null;
	readonly index: number;
	readonly canReorder: boolean;
	readonly canMoveBetweenWindows: boolean;
	readonly otherWindows: readonly WorkspaceWindowNode[];
	readonly newWindowEdges: WorkspaceSplitAdmissions;
}

export function resolveWorkspaceWindowTabActions(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
	tabs: WorkspaceWindowTabState,
	surfaceId: string,
	resolveAdmission: (
		edge: WorkspaceWindowEdge,
		movingSurfaceId: string,
	) => WorkspaceSplitAdmission | null,
): WorkspaceWindowTabActionState {
	const surface = snapshot.surfaces[surfaceId] ?? null;
	const index = tabs.order.indexOf(surfaceId);
	const canReorder = surface !== null && surface.type !== 'terminal-launcher' && index >= 0;
	const hasRequiredChatId = surface?.type !== 'chat' || Boolean(surface.chatId);
	const canMoveBetweenWindows = canReorder && hasRequiredChatId;
	const windows = collectWindowNodes(snapshot.desktopRoot);
	const canMoveToNewWindow = canMoveBetweenWindows && tabs.order.length > 1;
	return {
		surface,
		index,
		canReorder,
		canMoveBetweenWindows,
		otherWindows: canMoveBetweenWindows
			? windows.filter((workspaceWindow) => workspaceWindow.id !== windowId)
			: [],
		newWindowEdges: mapWorkspaceSplitAdmissions((edge) =>
			canMoveToNewWindow ? resolveAdmission(edge, surfaceId) : null,
		),
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
