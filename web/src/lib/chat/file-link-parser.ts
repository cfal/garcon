// Parses markdown link hrefs and classifies them as file links or ignored.
// Shared by all markdown consumers to determine whether a link should
// navigate to the Files tab.

export type FileLinkKind = 'file' | 'ignored';

export interface ParsedFileLink {
	kind: FileLinkKind;
	/** Normalized relative path (forward slashes, collapsed dots). */
	relativePath: string;
	/** Raw href before parsing. */
	rawHref: string;
	/** Line number extracted from :line or #Lxx suffix (future use). */
	line?: number;
	/** Column extracted from :line:col suffix (future use). */
	col?: number;
}

// Excludes dots from the scheme character class to avoid matching
// file-extension patterns like `file.ts:42` as URI schemes.
const SCHEME_RE = /^[a-z][a-z0-9+-]*:/i;
const PROTOCOL_RELATIVE_RE = /^\/\//;
const ABSOLUTE_UNIX_RE = /^\//;
const DRIVE_LETTER_RE = /^[A-Za-z]:[/\\]/;

/** Extracts optional :line[:col] or #Lxx suffix from a path. */
function extractLineInfo(path: string): { cleanPath: string; line?: number; col?: number } {
	// #Lxx or #Lxx-Lyy (GitHub-style line anchor)
	const hashMatch = path.match(/#L(\d+)(?:-L\d+)?$/);
	if (hashMatch) {
		return {
			cleanPath: path.slice(0, path.indexOf('#')),
			line: parseInt(hashMatch[1], 10),
		};
	}

	// :line or :line:col suffix (e.g. file.ts:42 or file.ts:42:10)
	const colonMatch = path.match(/:(\d+)(?::(\d+))?$/);
	if (colonMatch) {
		return {
			cleanPath: path.slice(0, path.indexOf(colonMatch[0])),
			line: parseInt(colonMatch[1], 10),
			col: colonMatch[2] ? parseInt(colonMatch[2], 10) : undefined,
		};
	}

	return { cleanPath: path };
}

/** Strips query string and hash fragments for path handling. */
function stripQueryAndHash(href: string): string {
	const queryIdx = href.indexOf('?');
	const hashIdx = href.indexOf('#');
	let end = href.length;
	if (queryIdx !== -1) end = Math.min(end, queryIdx);
	if (hashIdx !== -1) end = Math.min(end, hashIdx);
	return href.slice(0, end);
}

/**
 * Normalizes a relative path: converts backslashes, collapses `.`
 * segments, keeps `..` for server-side root enforcement.
 */
function normalizePath(raw: string): string {
	const parts = raw.replace(/\\/g, '/').split('/');
	const result: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') continue;
		if (part === '..') {
			result.push('..');
		} else {
			result.push(part);
		}
	}
	return result.join('/');
}

/**
 * Strips a directory prefix from an absolute path, returning the
 * relative remainder. Returns null if the path is not under the prefix.
 */
function stripBasePath(absolutePath: string, basePath: string): string | null {
	let prefix = basePath;
	if (!prefix.endsWith('/')) prefix += '/';
	if (absolutePath.startsWith(prefix)) {
		return absolutePath.slice(prefix.length);
	}
	return null;
}

export interface ParseFileLinkOptions {
	/** Absolute paths under this directory are accepted and relativized. */
	projectBasePath: string;
}

/**
 * Parses a markdown link href and classifies it as a file link or
 * ignored. File links are relative paths with path-like structure.
 * When projectBasePath is provided, absolute paths under it are
 * also accepted and converted to relative paths.
 * URL schemes and empty paths are always ignored.
 */
export function parseFileLink(rawHref: string | undefined | null, options?: ParseFileLinkOptions): ParsedFileLink {
	const ignored = (raw: string): ParsedFileLink => ({
		kind: 'ignored',
		relativePath: '',
		rawHref: raw,
	});

	if (!rawHref) return ignored('');

	const href = rawHref.trim();
	if (!href) return ignored(href);

	// Reject URLs with schemes (http:, https:, mailto:, etc.)
	if (SCHEME_RE.test(href)) return ignored(href);

	// Reject protocol-relative URLs
	if (PROTOCOL_RELATIVE_RE.test(href)) return ignored(href);

	// Decode URI components safely
	let decoded: string;
	try {
		decoded = decodeURIComponent(href);
	} catch {
		return ignored(href);
	}

	// Extract line/col info before stripping hash, since #Lxx is both
	// a hash fragment and a line marker.
	const { cleanPath: afterLineExtract, line, col } = extractLineInfo(decoded);

	// Strip remaining query/hash for path analysis
	const pathOnly = stripQueryAndHash(afterLineExtract);

	const isAbsolute = ABSOLUTE_UNIX_RE.test(pathOnly) || DRIVE_LETTER_RE.test(pathOnly);

	if (isAbsolute) {
		// Try to relativize against the base path
		const basePath = options?.projectBasePath;
		if (!basePath) return ignored(href);

		const relative = stripBasePath(pathOnly, basePath);
		if (!relative) return ignored(href);

		const normalized = normalizePath(relative);
		if (!normalized) return ignored(href);

		return { kind: 'file', relativePath: normalized, rawHref: href, line, col };
	}

	// Normalize
	const normalized = normalizePath(pathOnly);

	// Reject if normalization collapses to empty
	if (!normalized) return ignored(href);

	// At this point it's a relative path-like pattern
	return {
		kind: 'file',
		relativePath: normalized,
		rawHref: href,
		line,
		col,
	};
}

/** Returns true when the href looks like a file link. */
export function isFileLink(rawHref: string | undefined | null, options?: ParseFileLinkOptions): boolean {
	return parseFileLink(rawHref, options).kind === 'file';
}
