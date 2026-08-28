import {
	CHAT_SURFACE_ID,
	isTransientMobileSingletonKind,
	type PaneId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';
import { collectPaneNodes, paneIdOfSurface, paneNodeById } from './pane-tree.js';

function chatPaneId(snapshot: WorkspaceLayoutSnapshot): PaneId | null {
	return paneIdOfSurface(snapshot.desktopRoot, CHAT_SURFACE_ID);
}

function chatPaneActiveId(snapshot: WorkspaceLayoutSnapshot): string {
	const paneId = chatPaneId(snapshot);
	const pane = paneId ? paneNodeById(snapshot.desktopRoot, paneId) : null;
	return pane?.tabs.activeId ?? CHAT_SURFACE_ID;
}

export function selectMobileEntrySurface(
	layout: WorkspaceLayoutSnapshot,
	lastFocusedSurfaceId: string,
): string {
	if (layout.dialogFileSurfaceId) return layout.dialogFileSurfaceId;
	if (layout.fullscreenPaneId) {
		const pane = paneNodeById(layout.desktopRoot, layout.fullscreenPaneId);
		if (pane?.tabs.activeId) return pane.tabs.activeId;
	}
	for (const pane of collectPaneNodes(layout.desktopRoot)) {
		if (pane.tabs.activeId === lastFocusedSurfaceId) return lastFocusedSurfaceId;
	}
	return chatPaneActiveId(layout);
}

export function planDesktopReturnMutations(
	layout: WorkspaceLayoutSnapshot,
	mobileMruSurfaceIds: readonly string[],
): WorkspaceLayoutMutation[] {
	const mobileOnly = new Set(layout.mobileOnlySurfaceIds);
	if (mobileOnly.size === 0) return [];
	const destinationPaneId = chatPaneId(layout);
	if (!destinationPaneId) return [];
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
				mutations.push({ type: 'assign-to-pane', surfaceId, destinationPaneId });
			}
			continue;
		}
		if (surface.type === 'singleton' && surface.kind !== 'chat') {
			if (isTransientMobileSingletonKind(surface.kind)) {
				mutations.push({ type: 'remove-surface', surfaceId });
				continue;
			}
			mutations.push({ type: 'assign-to-pane', surfaceId, destinationPaneId });
		}
	}
	return mutations;
}
