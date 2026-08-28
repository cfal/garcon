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
import { collectPaneNodes, paneNodeById } from './pane-tree.js';
import type { WorkspaceLayoutReader } from './surface-types.js';

export type WorkspacePaneDropZone = SplitDropZone;

export interface WorkspacePaneDropTarget {
	paneId: PaneId;
	zone: WorkspacePaneDropZone;
	blockedReason?: 'max-panes';
}

export class WorkspacePaneDndStore {
	draggedSurfaceId = $state<string | null>(null);
	sourcePaneId = $state<PaneId | null>(null);
	activeTarget = $state<WorkspacePaneDropTarget | null>(null);

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

	// Returns the target to commit, or null when the drop is a no-op.
	handlePaneDrop(paneId: PaneId, event: DragEvent): WorkspacePaneDropTarget | null {
		const draggedSurfaceId = this.draggedSurfaceId;
		if (!draggedSurfaceId) return null;
		event.preventDefault();
		event.stopPropagation();
		const target =
			this.activeTarget?.paneId === paneId
				? this.activeTarget
				: this.#resolveTargetFromEvent(paneId, event);
		this.endDrag();
		if (!target || target.blockedReason) return null;
		// Dropping a tab onto the center of the pane it already belongs to is a no-op.
		if (target.zone === 'center' && this.#paneOf(draggedSurfaceId) === paneId) return null;
		return target;
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
		return { paneId, zone, blockedReason: this.#blockedReason(paneId, zone) };
	}

	#blockedReason(paneId: PaneId, zone: WorkspacePaneDropZone): 'max-panes' | undefined {
		if (!isSplitEdgeZone(zone)) return undefined;
		const draggedSurfaceId = this.draggedSurfaceId;
		if (!draggedSurfaceId) return undefined;
		// Splitting a tab out of a pane it solely occupies keeps the pane count flat.
		const sourcePaneId = this.#paneOf(draggedSurfaceId);
		if (sourcePaneId) {
			const sourcePane = paneNodeById(this.layout.snapshot.desktopRoot, sourcePaneId);
			if (sourcePane && sourcePane.tabs.order.length === 1) return undefined;
		}
		if (collectPaneNodes(this.layout.snapshot.desktopRoot).length >= MAX_WORKSPACE_PANES) {
			return 'max-panes';
		}
		return undefined;
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
