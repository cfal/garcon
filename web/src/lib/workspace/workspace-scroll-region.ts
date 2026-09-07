import type { Attachment } from 'svelte/attachments';

export const WORKSPACE_SCROLL_REGION_SELECTOR = '[data-workspace-scroll-region]';
const WORKSPACE_HALF_PAGE_SCROLL_EVENT = 'workspace-half-page-scroll';

export type WorkspaceScrollRegionRole = 'primary' | 'contextual';
export type WorkspaceHalfPageDirection = 'earlier' | 'later';

type WorkspaceScrollRegionHandler = (
	element: HTMLElement,
	direction: WorkspaceHalfPageDirection,
) => void;

interface WorkspaceHalfPageScrollDetail {
	direction: WorkspaceHalfPageDirection;
}

function registerWorkspaceScrollRegion(
	element: HTMLElement,
	role: WorkspaceScrollRegionRole,
): () => void {
	const previousRole = element.getAttribute('data-workspace-scroll-region');
	element.setAttribute('data-workspace-scroll-region', role);
	return () => {
		if (previousRole === null) element.removeAttribute('data-workspace-scroll-region');
		else element.setAttribute('data-workspace-scroll-region', previousRole);
	};
}

export function registerNativeWorkspaceScrollRegion(
	element: HTMLElement,
	role: WorkspaceScrollRegionRole,
): () => void {
	return registerWorkspaceScrollRegion(element, role);
}

export function registerManagedWorkspaceScrollRegion(
	element: HTMLElement,
	role: WorkspaceScrollRegionRole,
	handler: WorkspaceScrollRegionHandler,
): () => void {
	const unregister = registerWorkspaceScrollRegion(element, role);
	const handleHalfPageScroll = (event: Event): void => {
		const scrollEvent = event as CustomEvent<WorkspaceHalfPageScrollDetail>;
		event.preventDefault();
		handler(element, scrollEvent.detail.direction);
	};
	element.addEventListener(WORKSPACE_HALF_PAGE_SCROLL_EVENT, handleHalfPageScroll);
	return () => {
		element.removeEventListener(WORKSPACE_HALF_PAGE_SCROLL_EVENT, handleHalfPageScroll);
		unregister();
	};
}

export function nativeWorkspaceScrollRegion(
	role: WorkspaceScrollRegionRole,
): Attachment<HTMLElement> {
	return (element) => registerNativeWorkspaceScrollRegion(element, role);
}

export function managedWorkspaceScrollRegion(
	role: WorkspaceScrollRegionRole,
	handler: WorkspaceScrollRegionHandler,
): Attachment<HTMLElement> {
	return (element) => registerManagedWorkspaceScrollRegion(element, role, handler);
}

export function closestWorkspaceScrollRegion(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element
		? target.closest<HTMLElement>(WORKSPACE_SCROLL_REGION_SELECTOR)
		: null;
}

export function workspaceScrollRegionRole(
	element: HTMLElement,
): WorkspaceScrollRegionRole | null {
	const role = element.dataset.workspaceScrollRegion;
	return role === 'primary' || role === 'contextual' ? role : null;
}

export function scrollElementHalfPage(
	element: HTMLElement,
	direction: WorkspaceHalfPageDirection,
): void {
	const top = (direction === 'later' ? 1 : -1) * (element.clientHeight / 2);
	element.scrollBy({ top, behavior: 'auto' });
}

export function scrollWorkspaceRegion(
	element: HTMLElement,
	direction: WorkspaceHalfPageDirection,
): void {
	const event = new CustomEvent<WorkspaceHalfPageScrollDetail>(WORKSPACE_HALF_PAGE_SCROLL_EVENT, {
		cancelable: true,
		detail: { direction },
	});
	if (element.dispatchEvent(event)) scrollElementHalfPage(element, direction);
}
