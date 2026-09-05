import type {
	ChatViewSurfaceId,
	PresentationHostId,
	WorkspaceLayoutSnapshot,
	WorkspaceWindowId,
} from './surface-types.js';
import { collectWindowNodes, windowNodeById } from './window-tree.js';

export interface PortablePresentation {
	surfaceId: string;
	presentation: WorkspaceWindowId | 'mobile';
}

export interface RenderedPortablePresentation extends PortablePresentation {
	visible: boolean;
	windowId: WorkspaceWindowId | null;
}

export interface VisibleChatPresentation {
	readonly surfaceId: ChatViewSurfaceId;
	readonly chatId: string;
	readonly presentation: WorkspaceWindowId | 'mobile';
	readonly windowId: WorkspaceWindowId | null;
}

export interface VisiblePresentationOptions {
	readonly includeDialog?: boolean;
}

export function portablePresentationKey(
	presentation: WorkspaceWindowId,
	surfaceId: string,
): string {
	return `${presentation}:${surfaceId}`;
}

export function isDesktopWindowPresented(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
): boolean {
	return (
		windowNodeById(snapshot.desktopRoot, windowId) !== null &&
		(!snapshot.fullscreenWindowId || snapshot.fullscreenWindowId === windowId)
	);
}

export function visiblePresentationMap(
	snapshot: WorkspaceLayoutSnapshot,
	mode: 'desktop' | 'mobile',
	options: VisiblePresentationOptions = {},
): Map<PresentationHostId, string> {
	const visible = new Map<PresentationHostId, string>();
	if (mode === 'mobile') {
		visible.set('mobile', snapshot.mobileActiveSurfaceId);
		return visible;
	}
	const explicitWindowId = snapshot.fullscreenWindowId;
	const explicitWindow = explicitWindowId
		? windowNodeById(snapshot.desktopRoot, explicitWindowId)
		: null;
	const desktopWindows = explicitWindow
		? [explicitWindow]
		: collectWindowNodes(snapshot.desktopRoot);
	for (const workspaceWindow of desktopWindows) {
		visible.set(workspaceWindow.id, workspaceWindow.tabs.activeId);
	}
	if ((options.includeDialog ?? true) && snapshot.dialogFileSurfaceId) {
		visible.set('dialog', snapshot.dialogFileSurfaceId);
	}
	return visible;
}

export function visiblePortablePresentations(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
): PortablePresentation[] {
	const presentations: PortablePresentation[] = [];
	for (const [presentation, surfaceId] of visiblePresentationMap(
		snapshot,
		isMobile ? 'mobile' : 'desktop',
		{
			includeDialog: false,
		},
	)) {
		const surface = snapshot.surfaces[surfaceId];
		if (!surface || surface.type === 'chat') continue;
		presentations.push({
			surfaceId,
			presentation: presentation as WorkspaceWindowId | 'mobile',
		});
	}
	return presentations;
}

export function visibleChatPresentations(
	snapshot: WorkspaceLayoutSnapshot,
	mode: 'desktop' | 'mobile',
): VisibleChatPresentation[] {
	const presentations: VisibleChatPresentation[] = [];
	for (const [presentation, surfaceId] of visiblePresentationMap(snapshot, mode, {
		includeDialog: false,
	})) {
		const surface = snapshot.surfaces[surfaceId];
		if (surface?.type !== 'chat' || !surface.chatId) continue;
		presentations.push({
			surfaceId: surface.id,
			chatId: surface.chatId,
			presentation: presentation as WorkspaceWindowId | 'mobile',
			windowId: presentation === 'mobile' ? null : (presentation as WorkspaceWindowId),
		});
	}
	return presentations;
}

function visibleDesktopPresentationKeys(
	visible: readonly PortablePresentation[],
): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const { presentation, surfaceId } of visible) {
		if (presentation === 'mobile') continue;
		keys.add(portablePresentationKey(presentation, surfaceId));
	}
	return keys;
}

export function nextRetainedSingletonPresentationKeys(
	snapshot: WorkspaceLayoutSnapshot,
	isMobile: boolean,
	visible: readonly PortablePresentation[],
	current: ReadonlySet<string>,
): ReadonlySet<string> {
	if (isMobile) return new Set();
	const next = new Set<string>();
	const visibleKeys = visibleDesktopPresentationKeys(visible);
	for (const workspaceWindow of collectWindowNodes(snapshot.desktopRoot)) {
		for (const surfaceId of workspaceWindow.tabs.order) {
			if (snapshot.surfaces[surfaceId]?.type !== 'singleton') continue;
			const key = portablePresentationKey(workspaceWindow.id, surfaceId);
			if (current.has(key) || visibleKeys.has(key)) next.add(key);
		}
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
		const rendered: RenderedPortablePresentation[] = [];
		for (const item of visible) {
			if (item.presentation === 'mobile') {
				rendered.push({ ...item, visible: true, windowId: null });
			}
		}
		return rendered;
	}
	const visibleKeys = visibleDesktopPresentationKeys(visible);
	const fullscreenWindowId = snapshot.fullscreenWindowId;
	const rendered: RenderedPortablePresentation[] = [];
	for (const workspaceWindow of collectWindowNodes(snapshot.desktopRoot)) {
		for (const surfaceId of workspaceWindow.tabs.order) {
			if (snapshot.surfaces[surfaceId]?.type === 'chat') continue;
			const key = portablePresentationKey(workspaceWindow.id, surfaceId);
			const isVisible = visibleKeys.has(key);
			const isHiddenFullscreenActive =
				fullscreenWindowId !== null &&
				workspaceWindow.id !== fullscreenWindowId &&
				workspaceWindow.tabs.activeId === surfaceId;
			if (!isVisible && !retainedSingletonKeys.has(key) && !isHiddenFullscreenActive) continue;
			rendered.push({
				surfaceId,
				presentation: workspaceWindow.id,
				windowId: workspaceWindow.id,
				visible: isVisible,
			});
		}
	}
	return rendered;
}
