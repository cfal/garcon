import type { HostId, PresentationHostId, WorkspaceLayoutSnapshot } from './surface-types.js';
import { CHAT_SURFACE_ID } from './surface-types.js';

export interface PortablePresentation {
	surfaceId: string;
	presentation: HostId | 'mobile';
}

export interface RenderedPortablePresentation extends PortablePresentation {
	visible: boolean;
}

export function portablePresentationKey(presentation: HostId, surfaceId: string): string {
	return `${presentation}:${surfaceId}`;
}

export function visiblePresentationMap(
	snapshot: WorkspaceLayoutSnapshot,
	mode: 'desktop' | 'mobile',
	includeDialog = true,
): Map<PresentationHostId, string> {
	const visible = new Map<PresentationHostId, string>();
	if (mode === 'mobile') {
		visible.set('mobile', snapshot.mobileActiveSurfaceId);
		return visible;
	}
	visible.set('main', snapshot.main.activeId ?? CHAT_SURFACE_ID);
	if (snapshot.sidebarOpen && !snapshot.manualFullscreen && snapshot.sidebar.activeId) {
		visible.set('sidebar', snapshot.sidebar.activeId);
	}
	if (includeDialog && snapshot.dialogFileSurfaceId) {
		visible.set('dialog', snapshot.dialogFileSurfaceId);
	}
	return visible;
}

export function visiblePortablePresentations(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
): PortablePresentation[] {
	return [...visiblePresentationMap(snapshot, isMobile ? 'mobile' : 'desktop', false)]
		.filter(([, surfaceId]) => surfaceId !== CHAT_SURFACE_ID)
		.map(([presentation, surfaceId]) => ({
			surfaceId,
			presentation: presentation as HostId | 'mobile',
		}));
}

export function nextRetainedSingletonPresentationKeys(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
	visible: readonly PortablePresentation[],
	current: ReadonlySet<string>,
): ReadonlySet<string> {
	if (isMobile) return new Set();

	const next = new Set<string>();
	const visibleKeys = new Set(
		visible.flatMap(({ presentation, surfaceId }) =>
			presentation === 'mobile' ? [] : [portablePresentationKey(presentation, surfaceId)],
		),
	);
	const retainHost = (host: HostId): void => {
		for (const surfaceId of snapshot[host].order) {
			const surface = snapshot.surfaces[surfaceId];
			if (surface?.type !== 'singleton' || surface.kind === 'chat') continue;
			const key = portablePresentationKey(host, surfaceId);
			if (current.has(key) || visibleKeys.has(key)) next.add(key);
		}
	};

	retainHost('main');
	if (snapshot.sidebarOpen && !snapshot.manualFullscreen) retainHost('sidebar');
	return next;
}

export function renderedPortablePresentations(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
	visible: readonly PortablePresentation[],
	retainedSingletonKeys: ReadonlySet<string>,
): RenderedPortablePresentation[] {
	if (isMobile) return visible.map((item) => ({ ...item, visible: true }));

	const visibleKeys = new Set(
		visible.flatMap(({ presentation, surfaceId }) =>
			presentation === 'mobile' ? [] : [portablePresentationKey(presentation, surfaceId)],
		),
	);
	const rendered: RenderedPortablePresentation[] = [];
	const appendHost = (host: HostId): void => {
		for (const surfaceId of snapshot[host].order) {
			if (surfaceId === CHAT_SURFACE_ID) continue;
			const key = portablePresentationKey(host, surfaceId);
			const isVisible = visibleKeys.has(key);
			if (!isVisible && !retainedSingletonKeys.has(key)) continue;
			rendered.push({ surfaceId, presentation: host, visible: isVisible });
		}
	};

	appendHost('main');
	if (snapshot.sidebarOpen && !snapshot.manualFullscreen) appendHost('sidebar');
	return rendered;
}
