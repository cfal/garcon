import { base } from '$app/paths';
import { stripBasePath } from '$shared/base-path';

export function appPath(path: string): string {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
		throw new Error('Expected an application-relative absolute path');
	}
	return base + path;
}

export function appPathname(pathname: string): string {
	return stripBasePath(pathname, base) ?? '';
}
