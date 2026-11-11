import type { FileTreeEntry } from '$shared/file-contracts';

export const FILE_TREE_COLD_DIRECTORY_LIMIT = 64;
export const FILE_TREE_COLD_ROW_LIMIT = 5_000;
export const FILE_TREE_COLD_BYTE_LIMIT = 4 * 1024 * 1024;

export function pruneFileTreeCache(
	cache: Map<string, FileTreeEntry[]>,
	visibleExpanded: ReadonlySet<string>,
): Map<string, FileTreeEntry[]> {
	let retained = cache;
	let directories = 0;
	let rows = 0;
	let bytes = 0;
	for (const [path, entries] of [...cache].reverse()) {
		if (visibleExpanded.has(path)) continue;
		let entryBytes = path.length * 2;
		const exceedsCountOrRows =
			directories >= FILE_TREE_COLD_DIRECTORY_LIMIT ||
			rows + entries.length > FILE_TREE_COLD_ROW_LIMIT;
		if (!exceedsCountOrRows) {
			for (const entry of entries) {
				entryBytes +=
					80 +
					2 *
						(entry.name.length +
							entry.path.length +
							entry.relativePath.length +
							(entry.modified?.length ?? 0) +
							entry.permissionsRwx.length);
				if (bytes + entryBytes > FILE_TREE_COLD_BYTE_LIMIT) break;
			}
		}
		if (exceedsCountOrRows || bytes + entryBytes > FILE_TREE_COLD_BYTE_LIMIT) {
			if (retained === cache) retained = new Map(cache);
			retained.delete(path);
		} else {
			directories += 1;
			rows += entries.length;
			bytes += entryBytes;
		}
	}
	return retained;
}
