import {
	mapWorkspaceSplitAdmissions,
	resolveWorkspaceSplitAdmission,
	type WorkspaceSplitAdmission,
	type WorkspaceSplitAdmissionResolver,
	type WorkspaceSplitAdmissions,
	type WorkspaceSplitBlockReason,
} from '../window-geometry-policy.js';

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
	return mapWorkspaceSplitAdmissions(() => admission);
}

export function deniedWorkspaceSplits(reason: WorkspaceSplitBlockReason): WorkspaceSplitAdmissions {
	return workspaceSplitAdmissions({ allowed: false, reason });
}
