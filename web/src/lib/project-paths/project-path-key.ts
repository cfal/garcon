/** Preserves exact POSIX paths while matching drive-letter slash aliases. */
export function projectPathKey(path: string): string {
	return /^[a-z]:[/\\]/i.test(path) ? path.replaceAll('\\', '/') : path;
}
