import { effectiveExecutorId } from '$shared/executors';

export function fileIdentityKey(
	root: string,
	relativePath: string,
	executorId?: string | null,
): string {
	return JSON.stringify([effectiveExecutorId(executorId), root, relativePath]);
}
