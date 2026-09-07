import * as m from '$lib/paraglide/messages.js';
import {
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowEdge,
	type WorkspaceWindowId,
} from './surface-types.js';
import type {
	WorkspaceSplitAdmissionResolver,
	WorkspaceSplitBlockReason,
	WorkspaceSplitRequest,
} from './window-geometry-policy.js';

export function workspaceSplitBlockMessage(reason: WorkspaceSplitBlockReason): string {
	switch (reason) {
		case 'too-small':
			return m.workspace_split_too_small();
		case 'resource-ceiling':
			return m.workspace_window_limit_reached({ count: WORKSPACE_WINDOW_RESOURCE_CEILING });
		case 'fullscreen':
			return m.workspace_split_exit_fullscreen();
	}
}

export class WorkspaceSplitBlockedError extends Error {
	constructor(readonly reason: WorkspaceSplitBlockReason) {
		super(workspaceSplitBlockMessage(reason));
		this.name = 'WorkspaceSplitBlockedError';
	}
}

export function requireWorkspaceSplitAdmission(
	resolveAdmission: WorkspaceSplitAdmissionResolver,
	snapshot: WorkspaceLayoutSnapshot,
	request: WorkspaceSplitRequest,
): boolean {
	const admission = resolveAdmission(snapshot, request);
	if (!admission) return false;
	if (!admission.allowed) throw new WorkspaceSplitBlockedError(admission.reason);
	return true;
}

export function requireWorkspaceNewWindowEdge(
	resolveAdmission: WorkspaceSplitAdmissionResolver,
	snapshot: WorkspaceLayoutSnapshot,
	targetWindowId: WorkspaceWindowId,
): WorkspaceWindowEdge | null {
	let blockedReason: WorkspaceSplitBlockReason | null = null;
	// Opposite edges have identical geometry; prefer beside, then below the anchor.
	for (const edge of ['right', 'bottom'] as const) {
		const admission = resolveAdmission(snapshot, { targetWindowId, edge });
		if (!admission) return null;
		if (admission.allowed) return edge;
		blockedReason ??= admission.reason;
	}
	if (blockedReason) throw new WorkspaceSplitBlockedError(blockedReason);
	return null;
}
