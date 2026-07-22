import {
	MAX_PERSISTED_WORKSPACE_SIDEBAR_WIDTH,
	MIN_WORKSPACE_SIDEBAR_WIDTH,
} from './surface-types';

export interface SidebarMetrics {
	mode: 'push' | 'overlay';
	width: number;
}

export const WORKSPACE_SIDEBAR_HANDLE_WIDTH = 5;
export const DEFAULT_WORKSPACE_SIDEBAR_WIDTH = 480;
export const MIN_MAIN_HOST_WIDTH = 480;
export const MAX_OVERLAY_WORKSPACE_SIDEBAR_WIDTH = 560;

export function getPushSidebarMaximum(workspaceWidth: number, handleWidth: number): number {
	const safeWorkspaceWidth = Math.max(0, workspaceWidth);
	const safeHandleWidth = Math.max(0, handleWidth);
	return Math.min(
		safeWorkspaceWidth * 0.7,
		safeWorkspaceWidth - MIN_MAIN_HOST_WIDTH - safeHandleWidth,
	);
}

export function clampDesiredSidebarWidth(width: number): number {
	if (!Number.isFinite(width)) return MIN_WORKSPACE_SIDEBAR_WIDTH;
	return Math.min(
		MAX_PERSISTED_WORKSPACE_SIDEBAR_WIDTH,
		Math.max(MIN_WORKSPACE_SIDEBAR_WIDTH, Math.round(width)),
	);
}

export function clampPushSidebarWidth(width: number, pushMaximum: number): number {
	return Math.min(pushMaximum, Math.max(MIN_WORKSPACE_SIDEBAR_WIDTH, width));
}

export function resolveWorkspaceSidebarMetrics(
	workspaceWidth: number,
	handleWidth: number,
	desiredWidth: number,
): SidebarMetrics {
	const safeWorkspaceWidth = Math.max(0, workspaceWidth);
	const safeHandleWidth = Math.max(0, handleWidth);
	const pushMaximum = getPushSidebarMaximum(safeWorkspaceWidth, safeHandleWidth);
	if (pushMaximum >= MIN_WORKSPACE_SIDEBAR_WIDTH) {
		return {
			mode: 'push',
			width: Math.min(pushMaximum, Math.max(MIN_WORKSPACE_SIDEBAR_WIDTH, desiredWidth)),
		};
	}
	const overlayMaximum = Math.min(MAX_OVERLAY_WORKSPACE_SIDEBAR_WIDTH, safeWorkspaceWidth);
	return {
		mode: 'overlay',
		width: Math.min(
			overlayMaximum,
			Math.max(Math.min(MIN_WORKSPACE_SIDEBAR_WIDTH, safeWorkspaceWidth), desiredWidth),
		),
	};
}
