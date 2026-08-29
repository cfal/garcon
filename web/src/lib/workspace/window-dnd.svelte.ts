import {
	dragLeftWorkspaceWindow,
	resolveWorkspaceWindowDropZone,
	type WorkspaceWindowDropZone,
} from './window-drop-geometry.js';
import {
	MAX_WORKSPACE_WINDOWS,
	type WorkspaceLayoutSnapshot,
	type WorkspaceLayoutReader,
	type WorkspaceWindowId,
} from './surface-types.js';
import {
	collectWindowNodes,
	projectedWindowCountAfterTabMove,
	windowIdOfSurface,
	windowNodeById,
} from './window-tree.js';

const WORKSPACE_DRAG_MIME = 'application/x-garcon-workspace-drag';

export type WorkspaceDragPayload =
	| {
			kind: 'surface-tab';
			surfaceId: string;
			sourceWindowId: WorkspaceWindowId;
			sourceIndex: number;
	  }
	| { kind: 'chat'; chatId: string; source: 'chat-list' };

export type WorkspaceWindowDropTarget =
	| {
			kind: 'window';
			windowId: WorkspaceWindowId;
			zone: WorkspaceWindowDropZone;
			blockedReason?: 'max-windows' | 'same-window';
	  }
	| {
			kind: 'tab';
			windowId: WorkspaceWindowId;
			index: number;
			referenceSurfaceId: string | null;
			position: 'before' | 'after';
	  };

export interface WorkspaceWindowDropCommit {
	payload: WorkspaceDragPayload;
	target: WorkspaceWindowDropTarget;
}

export type WorkspaceWindowCenterDropResult = 'add-tab' | 'replace-chat';

export function resolveWorkspaceWindowCenterDropResult(
	snapshot: WorkspaceLayoutSnapshot,
	payload: WorkspaceDragPayload | null,
	destinationWindowId: WorkspaceWindowId,
): WorkspaceWindowCenterDropResult {
	const isChat =
		payload?.kind === 'chat' ||
		(payload?.kind === 'surface-tab' &&
			payload.sourceWindowId !== destinationWindowId &&
			snapshot.surfaces[payload.surfaceId]?.type === 'chat');
	if (!isChat) {
		return 'add-tab';
	}
	const destination = windowNodeById(snapshot.desktopRoot, destinationWindowId);
	return destination?.tabs.order.some((surfaceId) => snapshot.surfaces[surfaceId]?.type === 'chat')
		? 'replace-chat'
		: 'add-tab';
}

export class WorkspaceWindowDndController {
	payload = $state<WorkspaceDragPayload | null>(null);
	activeTarget = $state<WorkspaceWindowDropTarget | null>(null);

	constructor(private readonly layout: WorkspaceLayoutReader) {}

	get isDragging(): boolean {
		return this.payload !== null;
	}

	beginSurfaceTabDrag(
		surfaceId: string,
		sourceWindowId: WorkspaceWindowId,
		sourceIndex: number,
		event: DragEvent,
	): void {
		this.payload = { kind: 'surface-tab', surfaceId, sourceWindowId, sourceIndex };
		this.activeTarget = null;
		if (!event.dataTransfer) return;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData(WORKSPACE_DRAG_MIME, '1');
	}

	beginChatDrag(chatId: string): void {
		this.payload = { kind: 'chat', chatId, source: 'chat-list' };
		this.activeTarget = null;
	}

	endDrag(): void {
		this.payload = null;
		this.activeTarget = null;
	}

	handleWindowDragOver(windowId: WorkspaceWindowId, event: DragEvent): void {
		if (!this.payload) return;
		const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			'[data-workspace-window-id]',
		);
		if (!element) return;
		const rect = element.getBoundingClientRect();
		const zone = resolveWorkspaceWindowDropZone(rect, event.clientX, event.clientY);
		const target = this.#windowTarget(windowId, zone);
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = target.blockedReason ? 'none' : 'move';
		this.activeTarget = target;
	}

	handleWindowDragLeave(event: DragEvent): void {
		if (this.payload && dragLeftWorkspaceWindow(event)) this.activeTarget = null;
	}

	handleWindowDrop(
		windowId: WorkspaceWindowId,
		event: DragEvent,
	): WorkspaceWindowDropCommit | null {
		const payload = this.payload;
		if (!payload) return null;
		event.preventDefault();
		event.stopPropagation();
		const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			'[data-workspace-window-id]',
		);
		const rect = element?.getBoundingClientRect();
		const fallbackZone = rect
			? resolveWorkspaceWindowDropZone(rect, event.clientX, event.clientY)
			: null;
		const target =
			this.activeTarget?.kind === 'window' && this.activeTarget.windowId === windowId
				? this.activeTarget
				: fallbackZone
					? this.#windowTarget(windowId, fallbackZone)
					: null;
		this.endDrag();
		if (!target || target.blockedReason) return null;
		if (
			payload.kind === 'surface-tab' &&
			target.zone === 'center' &&
			payload.sourceWindowId === windowId
		) {
			return null;
		}
		return { payload, target };
	}

	handleTabDragOver(
		windowId: WorkspaceWindowId,
		referenceSurfaceId: string,
		event: DragEvent,
	): void {
		if (this.payload?.kind !== 'surface-tab') return;
		const target = this.#tabTarget(windowId, referenceSurfaceId, event);
		if (!target) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.activeTarget = target;
	}

	handleTabListDragOver(windowId: WorkspaceWindowId, event: DragEvent): void {
		if (this.payload?.kind !== 'surface-tab' || event.target !== event.currentTarget) return;
		const target = this.#tabListEndTarget(windowId);
		if (!target) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.activeTarget = target;
	}

	handleTabDrop(
		windowId: WorkspaceWindowId,
		referenceSurfaceId: string | null,
		event: DragEvent,
	): WorkspaceWindowDropCommit | null {
		const payload = this.payload;
		if (payload?.kind !== 'surface-tab') return null;
		event.preventDefault();
		event.stopPropagation();
		const target =
			this.activeTarget?.kind === 'tab' && this.activeTarget.windowId === windowId
				? this.activeTarget
				: referenceSurfaceId
					? this.#tabTarget(windowId, referenceSurfaceId, event)
					: this.#tabListEndTarget(windowId);
		this.endDrag();
		if (!target || this.#isTabDropNoOp(payload.surfaceId, target)) return null;
		return { payload, target };
	}

	#windowTarget(
		windowId: WorkspaceWindowId,
		zone: WorkspaceWindowDropZone,
	): Extract<WorkspaceWindowDropTarget, { kind: 'window' }> {
		return { kind: 'window', windowId, zone, blockedReason: this.#blockedReason(windowId, zone) };
	}

	#blockedReason(
		windowId: WorkspaceWindowId,
		zone: WorkspaceWindowDropZone,
	): 'max-windows' | 'same-window' | undefined {
		const payload = this.payload;
		if (!payload) return undefined;
		if (payload.kind === 'chat') {
			if (zone === 'center') return undefined;
			return collectWindowNodes(this.layout.snapshot.desktopRoot).length >= MAX_WORKSPACE_WINDOWS
				? 'max-windows'
				: undefined;
		}
		if (zone === 'center') return undefined;
		const sourceWindow = windowNodeById(this.layout.snapshot.desktopRoot, payload.sourceWindowId);
		if (payload.sourceWindowId === windowId && sourceWindow?.tabs.order.length === 1) {
			return 'same-window';
		}
		if (
			projectedWindowCountAfterTabMove(
				this.layout.snapshot.desktopRoot,
				payload.sourceWindowId,
				windowId,
			) > MAX_WORKSPACE_WINDOWS
		) {
			return 'max-windows';
		}
		return undefined;
	}

	#tabTarget(
		windowId: WorkspaceWindowId,
		referenceSurfaceId: string,
		event: DragEvent,
	): Extract<WorkspaceWindowDropTarget, { kind: 'tab' }> | null {
		const payload = this.payload;
		const workspaceWindow = windowNodeById(this.layout.snapshot.desktopRoot, windowId);
		if (
			payload?.kind !== 'surface-tab' ||
			!workspaceWindow ||
			!workspaceWindow.tabs.order.includes(referenceSurfaceId)
		) {
			return null;
		}
		if (referenceSurfaceId === payload.surfaceId && payload.sourceWindowId === windowId) {
			return {
				kind: 'tab',
				windowId,
				index: workspaceWindow.tabs.order.indexOf(payload.surfaceId),
				referenceSurfaceId,
				position: 'before',
			};
		}
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const pointerAfterMidpoint = event.clientX >= rect.left + rect.width / 2;
		const rtl = getComputedStyle(event.currentTarget as HTMLElement).direction === 'rtl';
		const position = pointerAfterMidpoint !== rtl ? 'after' : 'before';
		const order = workspaceWindow.tabs.order.filter((surfaceId) => surfaceId !== payload.surfaceId);
		const referenceIndex = order.indexOf(referenceSurfaceId);
		if (referenceIndex < 0) return null;
		return {
			kind: 'tab',
			windowId,
			index: referenceIndex + (position === 'after' ? 1 : 0),
			referenceSurfaceId,
			position,
		};
	}

	#tabListEndTarget(
		windowId: WorkspaceWindowId,
	): Extract<WorkspaceWindowDropTarget, { kind: 'tab' }> | null {
		const payload = this.payload;
		const workspaceWindow = windowNodeById(this.layout.snapshot.desktopRoot, windowId);
		if (payload?.kind !== 'surface-tab' || !workspaceWindow) return null;
		return {
			kind: 'tab',
			windowId,
			index: workspaceWindow.tabs.order.filter((id) => id !== payload.surfaceId).length,
			referenceSurfaceId: null,
			position: 'after',
		};
	}

	#isTabDropNoOp(
		surfaceId: string,
		target: Extract<WorkspaceWindowDropTarget, { kind: 'tab' }>,
	): boolean {
		const sourceWindowId = windowIdOfSurface(this.layout.snapshot.desktopRoot, surfaceId);
		if (sourceWindowId !== target.windowId) return false;
		return (
			windowNodeById(this.layout.snapshot.desktopRoot, sourceWindowId)?.tabs.order.indexOf(
				surfaceId,
			) === target.index
		);
	}
}
