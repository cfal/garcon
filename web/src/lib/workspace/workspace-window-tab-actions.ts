import type { WorkspaceCoordinator } from './workspace-coordinator.svelte.js';
import type {
	SurfaceDescriptor,
	WorkspaceLayoutSnapshot,
	WorkspaceWindowEdge,
	WorkspaceWindowId,
	WorkspaceWindowNode,
	WorkspaceWindowTabState,
} from './surface-types.js';
import { collectWindowNodes } from './window-tree.js';

export interface WorkspaceWindowTabActionState {
	readonly surface: SurfaceDescriptor | null;
	readonly index: number;
	readonly canReorder: boolean;
	readonly canMoveBetweenWindows: boolean;
	readonly canOpenInNewWindow: boolean;
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
	const canMoveBetweenWindows = canReorder && surface !== null && surface.type !== 'chat';
	return {
		surface,
		index,
		canReorder,
		canMoveBetweenWindows,
		canOpenInNewWindow:
			canReorder && surface !== null && (surface.type !== 'chat' || Boolean(surface.chatId)),
		otherWindows: canMoveBetweenWindows
			? collectWindowNodes(snapshot.desktopRoot).filter(
					(workspaceWindow) => workspaceWindow.id !== windowId,
				)
			: [],
	};
}

type NewWindowActionPort = Pick<
	WorkspaceCoordinator,
	'layout' | 'openChatInNewWindow' | 'openTabInNewWindow'
>;

export function openWorkspaceTabInNewWindow(
	workspace: NewWindowActionPort,
	surfaceId: string,
	windowId: WorkspaceWindowId,
	edge: WorkspaceWindowEdge,
): Promise<unknown> {
	const surface = workspace.layout.surface(surfaceId);
	if (!surface || surface.type === 'terminal-launcher') return Promise.resolve();
	if (surface.type === 'chat') {
		return surface.chatId
			? workspace.openChatInNewWindow(surface.chatId, windowId, edge)
			: Promise.resolve();
	}
	return workspace.openTabInNewWindow(surfaceId, windowId, edge);
}
