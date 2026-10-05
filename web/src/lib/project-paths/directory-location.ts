import { isWithinExecutorPath } from '$shared/executor-path';

export interface TypedDirectoryPath {
	/** Directory whose children complete the typed path. */
	readonly directory: string;
	/** Name being typed inside that directory, exactly as entered. */
	readonly partial: string;
}

export interface DirectoryBreadcrumb {
	readonly label: string;
	readonly path: string;
}

/** Drops trailing separators so one directory has one spelling. */
export function normalizeDirectoryPath(path: string): string {
	return path.replace(/\/+$/, '') || '/';
}

export function isWithinBasePath(path: string, basePath: string): boolean {
	return isWithinExecutorPath(normalizeDirectoryPath(basePath), normalizeDirectoryPath(path));
}

/** Splits a path under edit into its listed directory and the partial child name. */
export function splitTypedDirectoryPath(typed: string): TypedDirectoryPath {
	const lastSlash = typed.lastIndexOf('/');
	if (lastSlash < 0) return { directory: '/', partial: '' };
	return { directory: typed.slice(0, lastSlash) || '/', partial: typed.slice(lastSlash + 1) };
}

/** Returns null at the base, which bounds upward navigation. */
export function parentDirectoryPath(path: string, basePath: string): string | null {
	const directory = normalizeDirectoryPath(path);
	if (directory === normalizeDirectoryPath(basePath)) return null;
	return splitTypedDirectoryPath(directory).directory;
}

/** Lists the base and each directory below it down to the path. */
export function directoryBreadcrumbs(path: string, basePath: string): DirectoryBreadcrumb[] {
	const base = normalizeDirectoryPath(basePath);
	const breadcrumbs = [{ label: base.split('/').filter(Boolean).at(-1) ?? '/', path: base }];
	if (!isWithinBasePath(path, base)) return breadcrumbs;
	let current = base === '/' ? '' : base;
	for (const segment of normalizeDirectoryPath(path).slice(base.length).split('/').filter(Boolean)) {
		current += `/${segment}`;
		breadcrumbs.push({ label: segment, path: current });
	}
	return breadcrumbs;
}
