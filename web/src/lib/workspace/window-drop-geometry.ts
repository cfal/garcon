import type { WorkspaceWindowEdge } from './surface-types.js';

export type WorkspaceWindowDropZone = WorkspaceWindowEdge | 'center';

export interface WorkspaceWindowDropZonePresentation {
	zone: WorkspaceWindowDropZone;
	hitInsetClass: string;
	resultInsetClass: string;
}

export const WORKSPACE_WINDOW_DROP_ZONES: readonly WorkspaceWindowDropZonePresentation[] = [
	{
		zone: 'top',
		hitInsetClass: 'top-1.5 inset-x-1.5 bottom-[75%]',
		resultInsetClass: 'top-1.5 inset-x-1.5 bottom-[50%]',
	},
	{
		zone: 'bottom',
		hitInsetClass: 'bottom-1.5 inset-x-1.5 top-[75%]',
		resultInsetClass: 'bottom-1.5 inset-x-1.5 top-[50%]',
	},
	{
		zone: 'left',
		hitInsetClass: 'left-1.5 top-[25%] bottom-[25%] right-[75%]',
		resultInsetClass: 'left-1.5 inset-y-1.5 right-[50%]',
	},
	{
		zone: 'right',
		hitInsetClass: 'right-1.5 top-[25%] bottom-[25%] left-[75%]',
		resultInsetClass: 'right-1.5 inset-y-1.5 left-[50%]',
	},
	{
		zone: 'center',
		hitInsetClass: 'inset-[25%]',
		resultInsetClass: 'inset-1.5',
	},
];

export function resolveWorkspaceWindowDropZone(
	rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
	clientX: number,
	clientY: number,
): WorkspaceWindowDropZone {
	const x = clientX - rect.left;
	const y = clientY - rect.top;
	const edgeX = rect.width * 0.25;
	const edgeY = rect.height * 0.25;
	if (y < edgeY) return 'top';
	if (y > rect.height - edgeY) return 'bottom';
	if (x < edgeX) return 'left';
	if (x > rect.width - edgeX) return 'right';
	return 'center';
}

export function resolveDominantWorkspaceWindowEdge(
	rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
	clientX: number,
	clientY: number,
): WorkspaceWindowEdge {
	const normalizedX = (clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1);
	const normalizedY = (clientY - (rect.top + rect.height / 2)) / Math.max(rect.height, 1);
	if (Math.abs(normalizedX) >= Math.abs(normalizedY)) return normalizedX < 0 ? 'left' : 'right';
	return normalizedY < 0 ? 'top' : 'bottom';
}

export function dragLeftWorkspaceWindow(event: DragEvent): boolean {
	const related = event.relatedTarget as HTMLElement | null;
	return !related || !(event.currentTarget as HTMLElement).contains(related);
}
