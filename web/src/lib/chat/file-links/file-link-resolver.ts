import { parseFileLink } from '$lib/chat/file-links/file-link-parser.js';

export interface ResolveFileLinkTargetOptions {
	projectBasePath: string;
	chatProjectPath: string;
}

export interface ResolvedFileLinkTarget {
	fileRootPath: string;
	relativePath: string;
	line?: number;
	col?: number;
}

const DRIVE_ROOT_RE = /^([A-Za-z]:)(?:\/(.*)|$)/;

function stripQueryAndHash(href: string): string {
	const queryIdx = href.indexOf('?');
	const hashIdx = href.indexOf('#');
	let end = href.length;
	if (queryIdx !== -1) end = Math.min(end, queryIdx);
	if (hashIdx !== -1) end = Math.min(end, hashIdx);
	return href.slice(0, end);
}

function decodeHrefPath(rawHref: string | undefined | null): string | null {
	if (!rawHref) return null;
	try {
		return stripQueryAndHash(decodeURIComponent(rawHref.trim()));
	} catch {
		return null;
	}
}

function normalizeSlashes(path: string): string {
	return path.replace(/\\/g, '/');
}

function splitRoot(path: string): { root: string; rest: string } | null {
	const normalized = normalizeSlashes(path.trim());
	if (normalized.startsWith('/')) return { root: '/', rest: normalized.slice(1) };
	const drive = normalized.match(DRIVE_ROOT_RE);
	if (drive) return { root: `${drive[1]}/`, rest: drive[2] ?? '' };
	return null;
}

function normalizeAbsolutePath(path: string): string | null {
	const rootParts = splitRoot(path);
	if (!rootParts) return null;

	const segments: string[] = [];
	for (const segment of rootParts.rest.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}

	if (rootParts.root === '/') return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
	return `${rootParts.root}${segments.join('/')}`.replace(/\/$/, '');
}

function isAbsolutePath(path: string): boolean {
	return splitRoot(path) !== null;
}

function joinUnderRoot(rootPath: string, relativePath: string): string {
	const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
	const normalizedRelative = normalizeSlashes(relativePath).replace(/^\/+/, '');
	if (normalizedRoot === '') return `/${normalizedRelative}`;
	return `${normalizedRoot}/${normalizedRelative}`;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
	if (targetPath === rootPath) return true;
	const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
	return targetPath.startsWith(prefix);
}

function relativeFromRoot(targetPath: string, rootPath: string): string {
	if (targetPath === rootPath) return '';
	const prefix = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
	return targetPath.slice(prefix.length);
}

export function resolveFileLinkTarget(
	rawHref: string | undefined | null,
	options: ResolveFileLinkTargetOptions,
): ResolvedFileLinkTarget | null {
	const projectBasePath = normalizeAbsolutePath(options.projectBasePath);
	const chatProjectPath = normalizeAbsolutePath(options.chatProjectPath);
	if (!projectBasePath || !chatProjectPath) return null;
	if (!isWithinRoot(chatProjectPath, projectBasePath)) return null;

	const parsed = parseFileLink(rawHref, { projectBasePath });
	if (parsed.kind !== 'file') return null;

	const decodedPath = decodeHrefPath(rawHref);
	const startsAbsolute = decodedPath ? isAbsolutePath(decodedPath) : false;
	const targetPath = normalizeAbsolutePath(
		startsAbsolute
			? joinUnderRoot(projectBasePath, parsed.relativePath)
			: joinUnderRoot(chatProjectPath, parsed.relativePath),
	);
	if (!targetPath || !isWithinRoot(targetPath, projectBasePath)) return null;

	const relativePath = relativeFromRoot(targetPath, projectBasePath);
	if (!relativePath) return null;

	return {
		fileRootPath: projectBasePath,
		relativePath,
		line: parsed.line,
		col: parsed.col,
	};
}
