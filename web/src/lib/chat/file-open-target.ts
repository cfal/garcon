import {
	resolveFileLinkTarget,
	type ResolvedFileLinkTarget,
	type ResolveFileLinkTargetOptions,
} from './file-link-resolver';

export function resolveFileOpenTarget(
	filePath: string,
	options: ResolveFileLinkTargetOptions,
): ResolvedFileLinkTarget | null {
	return resolveFileLinkTarget(filePath, options);
}
