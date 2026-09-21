import { effectiveNodeId } from '$shared/execution-nodes';

export function fileIdentityKey(
	root: string,
	relativePath: string,
	nodeId?: string | null,
): string {
	return JSON.stringify([effectiveNodeId(nodeId), root, relativePath]);
}
