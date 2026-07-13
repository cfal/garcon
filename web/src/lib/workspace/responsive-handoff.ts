import {
	CHAT_SURFACE_ID,
	type HostId,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';

export function selectMobileEntrySurface(
	layout: WorkspaceLayoutSnapshot,
	lastFocusedSurfaceId: string,
): string {
	if (layout.dialogFileSurfaceId) return layout.dialogFileSurfaceId;
	const activeMainId = layout.main.activeId ?? CHAT_SURFACE_ID;
	const activeSidebarId =
		layout.sidebarOpen && !layout.manualFullscreen ? layout.sidebar.activeId : null;
	if (lastFocusedSurfaceId === activeMainId || lastFocusedSurfaceId === activeSidebarId) {
		return lastFocusedSurfaceId;
	}
	return activeMainId;
}

export function planDesktopReturnMutations(
	layout: WorkspaceLayoutSnapshot,
	mobileMruSurfaceIds: readonly string[],
): WorkspaceLayoutMutation[] {
	const mobileOnly = new Set(layout.mobileOnlySurfaceIds);
	if (mobileOnly.size === 0) return [];
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
				mutations.push({ type: 'assign-to-host', surfaceId, destination: 'main' });
			}
			continue;
		}
		if (surface.type === 'singleton') {
			const destination: HostId =
				surface.kind === 'files' || surface.kind === 'quick-git' ? 'sidebar' : 'main';
			mutations.push({ type: 'assign-to-host', surfaceId, destination });
		}
	}
	return mutations;
}
