// Computes the longest common directory prefix from a list of file paths
// and applies it to conventional commit messages.

const LOCK_EXTENSIONS = new Set([
	'.lock', '.sum', '.lockb',
]);

const GENERIC_TOKENS = new Set([
	'src', 'source', 'lib', 'pkg', 'packages', 'packages-ts',
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
 * Computes the longest common directory prefix from a list of file paths.
 * Ignores lock/sum files. Filters out generic path tokens.
 * Returns empty string when no meaningful common prefix exists.
 */
export function computeCommonDirPrefix(filePaths: string[]): string {
	const relevant = filePaths.filter((f) => !isIgnoredFile(f));
	if (relevant.length === 0) return '';

	const splitPaths = relevant.map((f) => f.split('/'));

	// Find common directory segments (excluding the filename itself).
	const dirs = splitPaths.map((parts) => parts.slice(0, -1));
	if (dirs.length === 0) return '';

	const commonParts: string[] = [];
	const minLen = Math.min(...dirs.map((d) => d.length));

	for (let i = 0; i < minLen; i++) {
		const segment = dirs[0][i];
		if (dirs.every((d) => d[i] === segment)) {
			commonParts.push(segment);
		} else {
			break;
		}
	}

	// Filter out generic tokens.
	const meaningful = commonParts.filter((t) => !GENERIC_TOKENS.has(t));
	if (meaningful.length === 0) return '';

	// If all files are in the same directory, use just the deepest meaningful segment.
	// Otherwise use the slash-joined meaningful path.
	const prefix = meaningful.join('/');

	// If the prefix looks like a single file (has an extension), strip the extension.
	if (meaningful.length === 1 && meaningful[0].includes('.')) {
		const dot = meaningful[0].lastIndexOf('.');
		return meaningful[0].substring(0, dot);
	}

	return prefix;
}

/**
 * Applies a directory prefix to a commit message.
 * For conventional commits (type(scope): subject), replaces the scope.
 * For conventional commits without scope (type: subject), inserts the scope.
 * Otherwise prepends "prefix: " to the message.
 */
export function applyDirPrefix(message: string, prefix: string): string {
	if (!prefix || !message) return message;

	const lines = message.split('\n');
	const firstLine = lines[0];

	// Match conventional commit: type(scope): subject or type: subject
	const conventionalMatch = firstLine.match(
		/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.*?\))?:\s*(.*)$/,
	);

	if (conventionalMatch) {
		const [, type, , subject] = conventionalMatch;
		lines[0] = `${type}(${prefix}): ${subject}`;
		return lines.join('\n');
	}

	// Non-conventional: prepend prefix
	lines[0] = `${prefix}: ${firstLine}`;
	return lines.join('\n');
}
