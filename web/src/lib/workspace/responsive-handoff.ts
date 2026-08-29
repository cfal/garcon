import {
	isTransientMobileSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import { collectWindowNodes, windowIdOfSurface, windowNodeById } from './window-tree.js';

export function selectMobileEntrySurface(
	layout: WorkspaceLayoutSnapshot,
	lastFocusedSurfaceId: string,
): string {
	if (layout.dialogFileSurfaceId) return layout.dialogFileSurfaceId;
	if (layout.fullscreenWindowId) {
		const workspaceWindow = windowNodeById(layout.desktopRoot, layout.fullscreenWindowId);
		if (workspaceWindow) return workspaceWindow.tabs.activeId;
	}
	const focusedWindowId = windowIdOfSurface(layout.desktopRoot, lastFocusedSurfaceId);
	if (focusedWindowId) {
		const workspaceWindow = windowNodeById(layout.desktopRoot, focusedWindowId);
		if (workspaceWindow?.tabs.activeId === lastFocusedSurfaceId) return lastFocusedSurfaceId;
		if (workspaceWindow) return workspaceWindow.tabs.activeId;
	}
	const first = collectWindowNodes(layout.desktopRoot)[0];
	if (!first) throw new Error('Workspace has no windows');
	return first.tabs.activeId;
}

export function planDesktopReturnMutations(
	layout: WorkspaceLayoutSnapshot,
	mobileMruSurfaceIds: readonly string[],
): WorkspaceLayoutMutation[] {
	const mobileOnly = new Set(layout.mobileOnlySurfaceIds);
	if (mobileOnly.size === 0) return [];
	const destinationWindowId =
		windowIdOfSurface(layout.desktopRoot, layout.mobileActiveSurfaceId) ??
		collectWindowNodes(layout.desktopRoot)[0]?.id;
	if (!destinationWindowId) return [];
	const ordered = mobileMruSurfaceIds.filter((surfaceId) => mobileOnly.has(surfaceId));
	for (const surfaceId of layout.mobileOnlySurfaceIds) {
		if (!ordered.includes(surfaceId)) ordered.push(surfaceId);
	}
	const firstMobileOnlyFile = ordered.find(
		(surfaceId) => layout.surfaces[surfaceId]?.type === 'file',
	);
	let dialogAvailable = layout.dialogFileSurfaceId === null;
	const mutations: WorkspaceLayoutMutation[] = [];
	for (const surfaceId of ordered) {
		const surface = layout.surfaces[surfaceId];
		if (!surface) continue;
		if (surface.type === 'file') {
			if (dialogAvailable && surfaceId === firstMobileOnlyFile) {
				mutations.push({ type: 'place-in-dialog', surfaceId });
				dialogAvailable = false;
			} else {
				mutations.push({ type: 'assign-to-window', surfaceId, destinationWindowId });
			}
			continue;
		}
		if (surface.type !== 'singleton') continue;
		if (isTransientMobileSingletonKind(surface.kind)) {
			mutations.push({ type: 'remove-surface', surfaceId });
			continue;
		}
		mutations.push({ type: 'assign-to-window', surfaceId, destinationWindowId });
	}
	return mutations;
}
