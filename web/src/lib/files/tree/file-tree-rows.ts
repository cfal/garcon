import type { FileTreeEntry } from '$shared/file-contracts';

export interface FileTableRow {
	key: string;
	entry: FileTreeEntry;
	level: number;
	parentKey: string | null;
	ancestorKeys: readonly string[];
}

function nestedRowKey(path: string, ancestorPaths: readonly string[]): string {
	return ancestorPaths.length === 0
		? path
		: `file-tree-row:${JSON.stringify([...ancestorPaths, path])}`;
}

export function buildVisibleFileRows(args: {
	rootEntries: readonly FileTreeEntry[];
	childrenByDirectory: ReadonlyMap<string, readonly FileTreeEntry[]>;
	expandedDirectories: ReadonlySet<string>;
	sortEntries: (entries: readonly FileTreeEntry[]) => FileTreeEntry[];
}): FileTableRow[] {
	const rows: FileTableRow[] = [];
	const append = (
		entries: readonly FileTreeEntry[],
		level: number,
		parentKey: string | null,
		ancestorPaths: readonly string[],
		ancestorKeys: readonly string[],
	): void => {
		for (const entry of args.sortEntries(entries)) {
			if (ancestorPaths.includes(entry.path)) continue;
			const key = nestedRowKey(entry.path, ancestorPaths);
			rows.push({ key, entry, level, parentKey, ancestorKeys });
			if (entry.type !== 'directory' || !args.expandedDirectories.has(entry.path)) continue;
			const children = args.childrenByDirectory.get(entry.path);
			if (children) {
				append(children, level + 1, key, [...ancestorPaths, entry.path], [...ancestorKeys, key]);
			}
		}
	};
	append(args.rootEntries, 1, null, [], []);
	return rows;
}

export function filterFileRows(rows: readonly FileTableRow[], query: string): FileTableRow[] {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return [...rows];
	const includedKeys = new Set<string>();
	for (const row of rows) {
		if (!row.entry.name.toLocaleLowerCase().includes(normalized)) continue;
		includedKeys.add(row.key);
		for (const ancestorKey of row.ancestorKeys) includedKeys.add(ancestorKey);
	}
	return rows.filter((row) => includedKeys.has(row.key));
}
