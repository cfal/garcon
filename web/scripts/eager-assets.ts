export interface ManifestEntry {
	file: string;
	name?: string;
	imports?: string[];
	dynamicImports?: string[];
	css?: string[];
}

export function collectEagerAssets(
	preloadedFiles: readonly string[],
	stylesheets: readonly string[],
	manifest: Readonly<Record<string, ManifestEntry>>,
) {
	const keysByFile = new Map<string, string[]>();
	for (const [key, entry] of Object.entries(manifest)) {
		keysByFile.set(entry.file, [...(keysByFile.get(entry.file) ?? []), key]);
	}
	const files = new Set<string>();
	const cssFiles = new Set(stylesheets);
	const queue = [...preloadedFiles];
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (files.has(file)) continue;
		files.add(file);
		for (const key of keysByFile.get(file) ?? []) {
			const entry = manifest[key];
			for (const cssFile of entry.css ?? []) cssFiles.add(cssFile);
			for (const importedKey of entry.imports ?? []) {
				const imported = manifest[importedKey];
				if (imported) queue.push(imported.file);
			}
		}
	}
	return { files, cssFiles, keysByFile };
}

export function assertLazyLanguageAssets(assets: readonly { file: string; names: readonly string[] }[]): void {
	const eagerLanguages = assets.filter(({ names }) => names.some(name =>
		(name.startsWith('vendor-cm-lang-') && name !== 'vendor-cm-lang-metadata') ||
		name === 'vendor-cm-legacy-modes',
	));
	if (eagerLanguages.length > 0) {
		throw new Error(`Language implementation chunks must remain lazy: ${eagerLanguages.map(asset => asset.file).join(', ')}`);
	}
}
