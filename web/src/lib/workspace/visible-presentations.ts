import type { PaneId, PresentationHostId, WorkspaceLayoutSnapshot } from './surface-types.js';
import { CHAT_SURFACE_ID } from './surface-types.js';
import { collectPaneNodes, paneNodeById } from './pane-tree.js';

export interface PortablePresentation {
	surfaceId: string;
	presentation: PaneId | 'mobile';
}

export interface RenderedPortablePresentation extends PortablePresentation {
	visible: boolean;
	paneId: PaneId | null;
}

export function portablePresentationKey(presentation: PaneId, surfaceId: string): string {
	return `${presentation}:${surfaceId}`;
}

export function isDesktopPanePresented(snapshot: WorkspaceLayoutSnapshot, paneId: PaneId): boolean {
	if (!paneNodeById(snapshot.desktopRoot, paneId)) return false;
	return snapshot.fullscreenPaneId === null || snapshot.fullscreenPaneId === paneId;
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
	for (const pane of collectPaneNodes(snapshot.desktopRoot)) {
		if (!isDesktopPanePresented(snapshot, pane.id)) continue;
		if (pane.tabs.activeId) visible.set(pane.id, pane.tabs.activeId);
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
		.filter(
			([presentation, surfaceId]) => presentation !== 'dialog' && surfaceId !== CHAT_SURFACE_ID,
		)
		.map(([presentation, surfaceId]) => ({
			surfaceId,
			presentation: presentation as PaneId | 'mobile',
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
	const retainPane = (paneId: PaneId): void => {
		const pane = paneNodeById(snapshot.desktopRoot, paneId);
		if (!pane) return;
		for (const surfaceId of pane.tabs.order) {
			const surface = snapshot.surfaces[surfaceId];
			if (surface?.type !== 'singleton' || surface.kind === 'chat') continue;
			const key = portablePresentationKey(paneId, surfaceId);
			if (current.has(key) || visibleKeys.has(key)) next.add(key);
		}
	};

	for (const pane of collectPaneNodes(snapshot.desktopRoot)) {
		if (isDesktopPanePresented(snapshot, pane.id)) retainPane(pane.id);
	}
	return next;
}

export function renderedPortablePresentations(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
	visible: readonly PortablePresentation[],
	retainedSingletonKeys: ReadonlySet<string>,
): RenderedPortablePresentation[] {
	if (isMobile) {
		return visible.flatMap((item) =>
			item.presentation === 'mobile' ? [{ ...item, visible: true, paneId: null }] : [],
		);
	}

	const visibleKeys = new Set(
		visible.flatMap(({ presentation, surfaceId }) =>
			presentation === 'mobile' ? [] : [portablePresentationKey(presentation, surfaceId)],
		),
	);
	const rendered: RenderedPortablePresentation[] = [];
	for (const pane of collectPaneNodes(snapshot.desktopRoot)) {
		if (!isDesktopPanePresented(snapshot, pane.id)) continue;
		for (const surfaceId of pane.tabs.order) {
			if (surfaceId === CHAT_SURFACE_ID) continue;
			const key = portablePresentationKey(pane.id, surfaceId);
			const isVisible = visibleKeys.has(key);
			if (!isVisible && !retainedSingletonKeys.has(key)) continue;
			rendered.push({ surfaceId, presentation: pane.id, paneId: pane.id, visible: isVisible });
		}
	}
	return rendered;
}
