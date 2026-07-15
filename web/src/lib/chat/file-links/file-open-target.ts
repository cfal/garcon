import {
	resolveFileLinkTarget,
	type ResolvedFileLinkTarget,
	type ResolveFileLinkTargetOptions,
} from '$lib/chat/file-links/file-link-resolver.js';

export function resolveFileOpenTarget(
	filePath: string,
	options: ResolveFileLinkTargetOptions,
): ResolvedFileLinkTarget | null {
	return resolveFileLinkTarget(filePath, options);
}
