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
	readonly projectedWindowId?: WorkspaceWindowId | null;
}

export type WorkspaceProjectionOptions = Pick<VisiblePresentationOptions, 'projectedWindowId'>;

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
	const explicitWindowId = snapshot.fullscreenWindowId ?? options.projectedWindowId ?? null;
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
	options: WorkspaceProjectionOptions = {},
): PortablePresentation[] {
	return [
		...visiblePresentationMap(snapshot, isMobile ? 'mobile' : 'desktop', {
			...options,
			includeDialog: false,
		}),
	].flatMap(([presentation, surfaceId]) => {
		const surface = snapshot.surfaces[surfaceId];
		if (!surface || surface.type === 'chat') return [];
		return [
			{
				surfaceId,
				presentation: presentation as WorkspaceWindowId | 'mobile',
			},
		];
	});
}

export function visibleChatPresentations(
	snapshot: WorkspaceLayoutSnapshot,
	mode: 'desktop' | 'mobile',
	options: WorkspaceProjectionOptions = {},
): VisibleChatPresentation[] {
	return [...visiblePresentationMap(snapshot, mode, { ...options, includeDialog: false })].flatMap(
		([presentation, surfaceId]) => {
			const surface = snapshot.surfaces[surfaceId];
			if (surface?.type !== 'chat' || !surface.chatId) return [];
			return [
				{
					surfaceId: surface.id,
					chatId: surface.chatId,
					presentation: presentation as WorkspaceWindowId | 'mobile',
					windowId: presentation === 'mobile' ? null : (presentation as WorkspaceWindowId),
				},
			];
		},
	);
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
	options: WorkspaceProjectionOptions = {},
): RenderedPortablePresentation[] {
	if (isMobile) {
		return visible.flatMap((item) =>
			item.presentation === 'mobile' ? [{ ...item, visible: true, windowId: null }] : [],
		);
	}
	const visibleKeys = new Set(
		visible.flatMap(({ presentation, surfaceId }) =>
			presentation === 'mobile' ? [] : [portablePresentationKey(presentation, surfaceId)],
		),
	);
	const projectedWindowId = snapshot.fullscreenWindowId ?? options.projectedWindowId ?? null;
	const rendered: RenderedPortablePresentation[] = [];
	for (const workspaceWindow of collectWindowNodes(snapshot.desktopRoot)) {
		for (const surfaceId of workspaceWindow.tabs.order) {
			if (snapshot.surfaces[surfaceId]?.type === 'chat') continue;
			const key = portablePresentationKey(workspaceWindow.id, surfaceId);
			const isVisible = visibleKeys.has(key);
			const isHiddenProjectedActive =
				projectedWindowId !== null &&
				workspaceWindow.id !== projectedWindowId &&
				workspaceWindow.tabs.activeId === surfaceId;
			if (!isVisible && !retainedSingletonKeys.has(key) && !isHiddenProjectedActive) continue;
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
