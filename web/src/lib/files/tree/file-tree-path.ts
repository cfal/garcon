import { isProjectPathAncestor, normalizeProjectPath } from '$lib/utils/project-path.js';

export function filePathRelativeToTreeRoot(
	treeRootPath: string,
	fileRootPath: string,
	fileRelativePath: string,
): string | null {
	const treeRoot = normalizeProjectPath(treeRootPath);
	const fileRoot = normalizeProjectPath(fileRootPath);
	if (!isProjectPathAncestor(treeRoot, fileRoot)) return null;
	const rootPrefix = treeRoot.endsWith('/') ? treeRoot : `${treeRoot}/`;
	const rootRelativePath = fileRoot === treeRoot ? '' : fileRoot.slice(rootPrefix.length);
	const relativePath = fileRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
	return [rootRelativePath, relativePath].filter(Boolean).join('/') || null;
}
