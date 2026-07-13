import type { HostId, WorkspaceLayoutSnapshot } from './surface-types.js';
import { CHAT_SURFACE_ID } from './surface-types.js';

export interface PortablePresentation {
	surfaceId: string;
	presentation: HostId | 'mobile';
}

export function visiblePortablePresentations(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
): PortablePresentation[] {
	if (isMobile) {
		return snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID
			? []
			: [{ surfaceId: snapshot.mobileActiveSurfaceId, presentation: 'mobile' }];
	}

	const presentations: PortablePresentation[] = [];
	const activeMain = snapshot.main.activeId ?? CHAT_SURFACE_ID;
	if (activeMain !== CHAT_SURFACE_ID) {
		presentations.push({ surfaceId: activeMain, presentation: 'main' });
	}
	if (snapshot.sidebarOpen && !snapshot.manualFullscreen && snapshot.sidebar.activeId) {
		presentations.push({
			surfaceId: snapshot.sidebar.activeId,
			presentation: 'sidebar',
		});
	}
	return presentations;
}
