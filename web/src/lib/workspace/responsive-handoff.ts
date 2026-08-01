import {
	CHAT_SURFACE_ID,
	isTransientMobileSingletonKind,
	type HostId,
	type PortableSingletonKind,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from './surface-types.js';

// The host a singleton lands in when a mobile session hands off to desktop.
// Shared so a surface opened on mobile can be registered where it will end up,
// which is also what makes it survive a reload (only hosted surfaces persist).
export function desktopHostForSingleton(kind: PortableSingletonKind): HostId {
	return kind === 'files' || kind === 'commit' ? 'sidebar' : 'main';
}

export function selectMobileEntrySurface(
	layout: WorkspaceLayoutSnapshot,
	lastFocusedSurfaceId: string,
): string {
	if (layout.dialogFileSurfaceId) return layout.dialogFileSurfaceId;
	const activeMainId = layout.main.activeId ?? CHAT_SURFACE_ID;
	const activeSidebarId = layout.sidebarOpen ? layout.sidebar.activeId : null;
	if (layout.fullscreenHost === 'main') return activeMainId;
	if (layout.fullscreenHost === 'sidebar') return activeSidebarId ?? activeMainId;
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
		if (surface.type === 'singleton' && surface.kind !== 'chat') {
			if (isTransientMobileSingletonKind(surface.kind)) {
				mutations.push({ type: 'remove-surface', surfaceId });
				continue;
			}
			mutations.push({
				type: 'assign-to-host',
				surfaceId,
				destination: desktopHostForSingleton(surface.kind),
			});
		}
	}
	return mutations;
}
