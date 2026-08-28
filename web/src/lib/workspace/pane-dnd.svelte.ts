// Drag state for moving workspace surface tabs between panes. Tab strips are
// drag sources; each pane body resolves a drop zone (edge splits, center adds
// the tab to the pane).

import {
	dragLeftContainer,
	isSplitEdgeZone,
	resolveDropZone,
	type SplitDropZone,
} from '$lib/utils/split-drop-geometry.js';
import { MAX_WORKSPACE_PANES, type PaneId } from './surface-types.js';
import {
	collectPaneNodes,
	paneNodeById,
	projectedPaneCountAfterTabSplit,
} from './pane-tree.js';
import type { WorkspaceLayoutReader } from './surface-types.js';

export type WorkspacePaneDropZone = SplitDropZone;

export interface WorkspacePaneDropTarget {
	kind: 'pane';
	paneId: PaneId;
	zone: WorkspacePaneDropZone;
	blockedReason?: 'max-panes' | 'same-pane';
}

export interface WorkspaceTabDropTarget {
	kind: 'tab';
	paneId: PaneId;
	index: number;
	referenceSurfaceId: string | null;
	position: 'before' | 'after';
}

export type WorkspaceDropTarget = WorkspacePaneDropTarget | WorkspaceTabDropTarget;

export interface WorkspaceDropCommit {
	surfaceId: string;
	target: WorkspaceDropTarget;
}

export class WorkspacePaneDndStore {
	draggedSurfaceId = $state<string | null>(null);
	sourcePaneId = $state<PaneId | null>(null);
	activeTarget = $state<WorkspaceDropTarget | null>(null);

	constructor(private readonly layout: WorkspaceLayoutReader) {}

	startTabDrag(surfaceId: string, sourcePaneId: PaneId, event: DragEvent): void {
		this.draggedSurfaceId = surfaceId;
		this.sourcePaneId = sourcePaneId;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', surfaceId);
		}
	}

	endDrag(): void {
		this.draggedSurfaceId = null;
		this.sourcePaneId = null;
		this.activeTarget = null;
	}

	handlePaneDragOver(paneId: PaneId, event: DragEvent): void {
		if (!this.draggedSurfaceId) return;
		const paneEl = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			'[data-workspace-pane-id]',
		);
		if (!paneEl) return;
		const rect = paneEl.getBoundingClientRect();
		const zone = resolveDropZone(rect, event.clientX, event.clientY);
		const target = this.#toTarget(paneId, zone);
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = target.blockedReason ? 'none' : 'move';
		}
		this.activeTarget = target;
	}

	handlePaneDragLeave(event: DragEvent): void {
		if (!this.draggedSurfaceId) return;
		if (dragLeftContainer(event)) this.activeTarget = null;
	}

	// Returns the drag payload and destination together before clearing transient state.
	handlePaneDrop(paneId: PaneId, event: DragEvent): WorkspaceDropCommit | null {
		const draggedSurfaceId = this.draggedSurfaceId;
		if (!draggedSurfaceId) return null;
		event.preventDefault();
		event.stopPropagation();
		const target =
			this.activeTarget?.kind === 'pane' && this.activeTarget.paneId === paneId
				? this.activeTarget
				: this.#resolveTargetFromEvent(paneId, event);
		this.endDrag();
		if (!target || target.blockedReason) return null;
		// Dropping a tab onto the center of the pane it already belongs to is a no-op.
		if (target.zone === 'center' && this.#paneOf(draggedSurfaceId) === paneId) return null;
		return { surfaceId: draggedSurfaceId, target };
	}

	handleTabDragOver(paneId: PaneId, referenceSurfaceId: string, event: DragEvent): void {
		if (!this.draggedSurfaceId) return;
		const target = this.#tabTarget(paneId, referenceSurfaceId, event);
		if (!target) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.activeTarget = target;
	}

	handleTabListDragOver(paneId: PaneId, event: DragEvent): void {
		if (!this.draggedSurfaceId || event.target !== event.currentTarget) return;
		const target = this.#tabListEndTarget(paneId);
		if (!target) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.activeTarget = target;
	}

	handleTabDrop(
		paneId: PaneId,
		referenceSurfaceId: string | null,
		event: DragEvent,
	): WorkspaceDropCommit | null {
		const draggedSurfaceId = this.draggedSurfaceId;
		if (!draggedSurfaceId) return null;
		event.preventDefault();
		event.stopPropagation();
		const target =
			this.activeTarget?.kind === 'tab' && this.activeTarget.paneId === paneId
				? this.activeTarget
				: referenceSurfaceId
					? this.#tabTarget(paneId, referenceSurfaceId, event)
					: this.#tabListEndTarget(paneId);
		this.endDrag();
		if (!target || this.#isTabDropNoOp(draggedSurfaceId, target)) return null;
		return { surfaceId: draggedSurfaceId, target };
	}

	#resolveTargetFromEvent(paneId: PaneId, event: DragEvent): WorkspacePaneDropTarget | null {
		const paneEl = (event.currentTarget as HTMLElement).closest<HTMLElement>(
			'[data-workspace-pane-id]',
		);
		if (!paneEl) return null;
		return this.#toTarget(
			paneId,
			resolveDropZone(paneEl.getBoundingClientRect(), event.clientX, event.clientY),
		);
	}

	#toTarget(paneId: PaneId, zone: WorkspacePaneDropZone): WorkspacePaneDropTarget {
		return { kind: 'pane', paneId, zone, blockedReason: this.#blockedReason(paneId, zone) };
	}

	#blockedReason(
		paneId: PaneId,
		zone: WorkspacePaneDropZone,
	): 'max-panes' | 'same-pane' | undefined {
		if (!isSplitEdgeZone(zone)) return undefined;
		const draggedSurfaceId = this.draggedSurfaceId;
		if (!draggedSurfaceId) return undefined;
		const sourcePaneId = this.#paneOf(draggedSurfaceId);
		if (!sourcePaneId) return undefined;
		const sourcePane = paneNodeById(this.layout.snapshot.desktopRoot, sourcePaneId);
		if (sourcePaneId === paneId && sourcePane?.tabs.order.length === 1) return 'same-pane';
		if (
			projectedPaneCountAfterTabSplit(this.layout.snapshot.desktopRoot, sourcePaneId, paneId) >
			MAX_WORKSPACE_PANES
		) {
			return 'max-panes';
		}
		return undefined;
	}

	#tabTarget(
		paneId: PaneId,
		referenceSurfaceId: string,
		event: DragEvent,
	): WorkspaceTabDropTarget | null {
		const draggedSurfaceId = this.draggedSurfaceId;
		const pane = paneNodeById(this.layout.snapshot.desktopRoot, paneId);
		const target = event.currentTarget as HTMLElement;
		if (!draggedSurfaceId || !pane || !pane.tabs.order.includes(referenceSurfaceId)) return null;
		if (referenceSurfaceId === draggedSurfaceId && this.#paneOf(draggedSurfaceId) === paneId) {
			return {
				kind: 'tab',
				paneId,
				index: pane.tabs.order.indexOf(draggedSurfaceId),
				referenceSurfaceId,
				position: 'before',
			};
		}
		const rect = target.getBoundingClientRect();
		const pointerAfterMidpoint = event.clientX >= rect.left + rect.width / 2;
		const rtl = getComputedStyle(target).direction === 'rtl';
		const position = pointerAfterMidpoint !== rtl ? 'after' : 'before';
		const destinationOrder = pane.tabs.order.filter((surfaceId) => surfaceId !== draggedSurfaceId);
		const referenceIndex = destinationOrder.indexOf(referenceSurfaceId);
		if (referenceIndex < 0) return null;
		return {
			kind: 'tab',
			paneId,
			index: referenceIndex + (position === 'after' ? 1 : 0),
			referenceSurfaceId,
			position,
		};
	}

	#tabListEndTarget(paneId: PaneId): WorkspaceTabDropTarget | null {
		const draggedSurfaceId = this.draggedSurfaceId;
		const pane = paneNodeById(this.layout.snapshot.desktopRoot, paneId);
		if (!draggedSurfaceId || !pane) return null;
		return {
			kind: 'tab',
			paneId,
			index: pane.tabs.order.filter((surfaceId) => surfaceId !== draggedSurfaceId).length,
			referenceSurfaceId: null,
			position: 'after',
		};
	}

	#isTabDropNoOp(surfaceId: string, target: WorkspaceTabDropTarget): boolean {
		const sourcePaneId = this.#paneOf(surfaceId);
		if (sourcePaneId !== target.paneId) return false;
		const sourcePane = paneNodeById(this.layout.snapshot.desktopRoot, sourcePaneId);
		return sourcePane?.tabs.order.indexOf(surfaceId) === target.index;
	}

	#paneOf(surfaceId: string): PaneId | null {
		for (const pane of collectPaneNodes(this.layout.snapshot.desktopRoot)) {
			if (pane.tabs.order.includes(surfaceId)) return pane.id;
		}
		return null;
	}
}

export function createWorkspacePaneDndStore(layout: WorkspaceLayoutReader): WorkspacePaneDndStore {
	return new WorkspacePaneDndStore(layout);
}
