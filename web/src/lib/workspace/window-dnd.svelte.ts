import {
	dragLeftWorkspaceWindow,
	resolveWorkspaceWindowDropZone,
	type WorkspaceWindowDropZone,
} from './window-drop-geometry.js';
import {
	type WorkspaceLayoutSnapshot,
	type WorkspaceLayoutReader,
	type WorkspaceWindowId,
} from './surface-types.js';
import { windowIdOfSurface, windowNodeById } from './window-tree.js';
import { findWorkspaceChatPlacement } from './workspace-chat-placement.js';
import type {
	WorkspaceSplitAdmissionResolver,
	WorkspaceSplitBlockReason,
} from './window-geometry-policy.js';

export const WORKSPACE_DRAG_MIME = 'application/x-garcon-workspace-drag';

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
			blockedReason?: WorkspaceSplitBlockReason | 'same-window';
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
	#chatDropTargets = $state.raw<
		ReadonlyMap<
			string,
			{ element: HTMLElement; drop: (chatId: string, point: { x: number; y: number }) => void }
		>
	>(new Map());

	constructor(
		private readonly layout: WorkspaceLayoutReader,
		private readonly resolveSplitAdmission: WorkspaceSplitAdmissionResolver,
	) {}

	get isDragging(): boolean {
		return this.payload !== null;
	}

	hasChatPlacement(chatId: string): boolean {
		return findWorkspaceChatPlacement(this.layout.snapshot, chatId) !== null;
	}

	registerChatDropTarget(
		windowId: string,
		element: HTMLElement,
		drop: (chatId: string, point: { x: number; y: number }) => void,
	): () => void {
		const target = { element, drop };
		this.#chatDropTargets = new Map(this.#chatDropTargets).set(windowId, target);
		return () => {
			if (this.#chatDropTargets.get(windowId) !== target) return;
			const next = new Map(this.#chatDropTargets);
			next.delete(windowId);
			this.#chatDropTargets = next;
		};
	}

	hasChatDropTarget(windowId: string): boolean {
		return this.payload?.kind === 'chat' && this.#chatDropTargets.has(windowId);
	}

	#contentTarget(windowId: string, event: DragEvent) {
		const target = this.payload?.kind === 'chat' ? this.#chatDropTargets.get(windowId) : null;
		if (!target) return null;
		const rect = target.element.getBoundingClientRect();
		return event.clientX >= rect.left &&
			event.clientX <= rect.right &&
			event.clientY >= rect.top &&
			event.clientY <= rect.bottom
			? target
			: null;
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
		if (this.#contentTarget(windowId, event)) {
			event.preventDefault();
			event.stopPropagation();
			this.activeTarget = null;
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			return;
		}
		const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			'[data-workspace-window-id]',
		);
		if (!element) return;
		const rect = element.getBoundingClientRect();
		const zone = resolveWorkspaceWindowDropZone(rect, event.clientX, event.clientY);
		const target = this.#windowTarget(windowId, zone);
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = target && !target.blockedReason ? 'move' : 'none';
		}
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
		const contentTarget = this.#contentTarget(windowId, event);
		if (contentTarget && payload.kind === 'chat') {
			this.endDrag();
			contentTarget.drop(payload.chatId, { x: event.clientX, y: event.clientY });
			return null;
		}
		const element = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			'[data-workspace-window-id]',
		);
		const rect = element?.getBoundingClientRect();
		const fallbackZone = rect
			? resolveWorkspaceWindowDropZone(rect, event.clientX, event.clientY)
			: null;
		let target: Extract<WorkspaceWindowDropTarget, { kind: 'window' }> | null = null;
		if (this.activeTarget?.kind === 'window' && this.activeTarget.windowId === windowId) {
			target = this.activeTarget;
		} else if (fallbackZone) {
			target = this.#windowTarget(windowId, fallbackZone);
		}
		const currentTarget = target ? this.#windowTarget(windowId, target.zone) : null;
		this.endDrag();
		if (!currentTarget || currentTarget.blockedReason) return null;
		if (
			payload.kind === 'surface-tab' &&
			currentTarget.zone === 'center' &&
			payload.sourceWindowId === windowId
		) {
			return null;
		}
		return { payload, target: currentTarget };
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
		let target: Extract<WorkspaceWindowDropTarget, { kind: 'tab' }> | null;
		if (this.activeTarget?.kind === 'tab' && this.activeTarget.windowId === windowId) {
			target = this.activeTarget;
		} else if (referenceSurfaceId) {
			target = this.#tabTarget(windowId, referenceSurfaceId, event);
		} else {
			target = this.#tabListEndTarget(windowId);
		}
		this.endDrag();
		if (!target || this.#isTabDropNoOp(payload.surfaceId, target)) return null;
		return { payload, target };
	}

	#windowTarget(
		windowId: WorkspaceWindowId,
		zone: WorkspaceWindowDropZone,
	): Extract<WorkspaceWindowDropTarget, { kind: 'window' }> | null {
		const blockedReason = this.#blockedReason(windowId, zone);
		if (blockedReason === null) return null;
		return { kind: 'window', windowId, zone, blockedReason };
	}

	#blockedReason(
		windowId: WorkspaceWindowId,
		zone: WorkspaceWindowDropZone,
	): WorkspaceSplitBlockReason | 'same-window' | null | undefined {
		const payload = this.payload;
		if (!payload) return undefined;
		if (payload.kind === 'chat' && this.hasChatPlacement(payload.chatId)) return undefined;
		if (zone === 'center') return undefined;
		if (payload.kind === 'surface-tab') {
			const sourceWindow = windowNodeById(this.layout.snapshot.desktopRoot, payload.sourceWindowId);
			if (payload.sourceWindowId === windowId && sourceWindow?.tabs.order.length === 1) {
				return 'same-window';
			}
		}
		const admission = this.resolveSplitAdmission(this.layout.snapshot, {
			targetWindowId: windowId,
			edge: zone,
			movingSurfaceId: payload.kind === 'surface-tab' ? payload.surfaceId : undefined,
		});
		if (!admission) return null;
		return admission.allowed ? undefined : admission.reason;
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
