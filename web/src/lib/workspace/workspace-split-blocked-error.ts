import * as m from '$lib/paraglide/messages.js';
import {
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	type WorkspaceLayoutSnapshot,
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
