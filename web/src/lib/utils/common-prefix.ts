// Computes the longest common prefix from a list of file paths.
// For single-file commits the prefix includes the filename itself.

const LOCK_EXTENSIONS = new Set([
	'.lock', '.sum', '.lockb',
]);

const GENERIC_TOKENS = new Set([
	'src', 'source', 'sources', 'lib', 'pkg', 'packages', 'packages-ts',
	'internal', 'cmd', 'app', 'apps',
]);

/** Returns true for files that should be ignored when computing the prefix
 *  (lockfiles, checksums, etc.). */
function isIgnoredFile(filePath: string): boolean {
	const lastDot = filePath.lastIndexOf('.');
	if (lastDot === -1) return false;
	return LOCK_EXTENSIONS.has(filePath.substring(lastDot));
}

/**
 * Computes the longest common prefix from a list of file paths.
 * For a single (non-ignored) file the full path is used as the prefix,
 * including the filename. For multiple files, reduces to the deepest
 * shared directory. Ignored files (lockfiles, checksums) are skipped
 * unless every file is ignored, in which case they are all considered.
 * Generic path tokens (src, lib, etc.) are stripped from the result.
 * File extensions are trimmed when `trimExtension` is true.
 */
export function computeCommonDirPrefix(filePaths: string[], trimExtension = false): string {
	if (!filePaths.length) return '';

	// Find the first non-ignored file to seed the prefix.
	let startIdx = 0;
	let allIgnored = false;
	while (startIdx < filePaths.length && isIgnoredFile(filePaths[startIdx])) {
		startIdx++;
	}
	// If every file is ignored, fall back to computing from all of them.
	if (startIdx >= filePaths.length) {
		startIdx = 0;
		allIgnored = true;
	}

	// Seed with the full path (including filename) then narrow down.
	let currentPrefix = filePaths[startIdx];

	for (let j = startIdx + 1; j < filePaths.length; j++) {
		const f = filePaths[j];
		if (!allIgnored && isIgnoredFile(f)) continue;

		// Pop trailing segments until currentPrefix is a directory ancestor of f.
		while (currentPrefix && !f.startsWith(currentPrefix + '/')) {
			const tokens = currentPrefix.split('/');
			tokens.pop();
			currentPrefix = tokens.join('/');
		}
	}

	if (!currentPrefix) return '';

	// Filter out generic tokens.
	const tokens = currentPrefix.split('/');
	const meaningful = tokens.filter((t) => !GENERIC_TOKENS.has(t));
	if (!meaningful.length) return '';

	let prefix = meaningful.join('/');

	// Optionally strip the file extension.
	if (trimExtension) {
		const dot = prefix.lastIndexOf('.');
		const slash = prefix.lastIndexOf('/');
		if (dot > slash) {
			prefix = prefix.substring(0, dot);
		}
	}

	return prefix;
}

/** Prepends "prefix: " to the first line of a commit message. */
export function applyDirPrefix(message: string, prefix: string): string {
	if (!prefix || !message) return message;

	const lines = message.split('\n');
	lines[0] = `${prefix}: ${lines[0]}`;
	return lines.join('\n');
}
