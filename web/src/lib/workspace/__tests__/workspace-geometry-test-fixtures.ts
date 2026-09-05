import { WORKSPACE_WINDOW_EDGES } from '../surface-types.js';
import type {
	WorkspaceSplitAdmission,
	WorkspaceSplitAdmissionResolver,
	WorkspaceSplitAdmissions,
	WorkspaceSplitBlockReason,
} from '../window-geometry-policy.js';
import { resolveWorkspaceSplitAdmission } from '../window-geometry-policy.js';

export const allowWorkspaceSplit: WorkspaceSplitAdmissionResolver = () => ({ allowed: true });

export const resolveUnmeasuredWorkspaceSplit: WorkspaceSplitAdmissionResolver = (
	snapshot,
	request,
) =>
	resolveWorkspaceSplitAdmission({
		snapshot,
		hostSize: null,
		singleWindowProjectionActive: false,
		...request,
	});

export function workspaceSplitAdmissions(
	admission: WorkspaceSplitAdmission | null = { allowed: true },
): WorkspaceSplitAdmissions {
	return Object.fromEntries(
		WORKSPACE_WINDOW_EDGES.map((edge) => [edge, admission]),
	) as WorkspaceSplitAdmissions;
}

export function deniedWorkspaceSplits(reason: WorkspaceSplitBlockReason): WorkspaceSplitAdmissions {
	return workspaceSplitAdmissions({ allowed: false, reason });
}
