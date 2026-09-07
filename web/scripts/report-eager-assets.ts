import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface ManifestEntry {
	file: string;
	name?: string;
	imports?: string[];
	css?: string[];
}

interface AssetReport {
	file: string;
	bytes: number;
	names: string[];
}

const webRoot = process.cwd();
const buildRoot = path.join(webRoot, 'build');
const manifestPath = path.join(webRoot, '.svelte-kit/output/client/.vite/manifest.json');
const indexPath = path.join(buildRoot, 'index.html');

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function normalizedAssetPath(href: string): string {
	const normalized = href.replace(/^\//, '').split(/[?#]/, 1)[0];
	if (!normalized || normalized.split('/').includes('..')) {
		throw new Error(`Invalid build asset path: ${href}`);
	}
	return normalized;
}

function linkedAssets(html: string, relation: 'modulepreload' | 'stylesheet'): string[] {
	const assets: string[] = [];
	for (const match of html.matchAll(/<link\b[^>]*>/g)) {
		const tag = match[0];
		if (!new RegExp(`\\brel=["']${relation}["']`).test(tag)) continue;
		const href = tag.match(/\bhref=["']([^"']+)["']/)?.[1];
		if (href) assets.push(normalizedAssetPath(href));
	}
	return assets;
}

function reportAssets(
	files: Iterable<string>,
	keysByFile: ReadonlyMap<string, string[]>,
	manifest: Readonly<Record<string, ManifestEntry>>,
): AssetReport[] {
	return Array.from(new Set(files), (file) => ({
		file,
		bytes: statSync(path.join(buildRoot, file)).size,
		names: Array.from(
			new Set((keysByFile.get(file) ?? []).flatMap((key) => manifest[key]?.name ?? [])),
		).sort(),
	})).sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
}

function sumBytes(assets: readonly AssetReport[]): number {
	return assets.reduce((total, asset) => total + asset.bytes, 0);
}

function collectFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const absolute = path.join(directory, entry.name);
		return entry.isDirectory() ? collectFiles(absolute) : [absolute];
	});
}

function packageVersion(packageName: string): string {
	return readJson<{ version: string }>(path.join(webRoot, 'node_modules', packageName, 'package.json'))
		.version;
}

const manifest = readJson<Record<string, ManifestEntry>>(manifestPath);
const html = readFileSync(indexPath, 'utf8');
const keysByFile = new Map<string, string[]>();
for (const [key, entry] of Object.entries(manifest)) {
	keysByFile.set(entry.file, [...(keysByFile.get(entry.file) ?? []), key]);
}

const preloadFiles = linkedAssets(html, 'modulepreload');
const eagerFiles = new Set<string>();
const eagerCssFiles = new Set(linkedAssets(html, 'stylesheet'));
const queue = [...preloadFiles];

while (queue.length > 0) {
	const file = queue.pop();
	if (!file || eagerFiles.has(file)) continue;
	eagerFiles.add(file);
	for (const key of keysByFile.get(file) ?? []) {
		const entry = manifest[key];
		for (const cssFile of entry.css ?? []) eagerCssFiles.add(cssFile);
		for (const importedKey of entry.imports ?? []) {
			const imported = manifest[importedKey];
			if (imported) queue.push(imported.file);
		}
	}
}

const preloadJs = reportAssets(
	preloadFiles.filter((file) => file.endsWith('.js')),
	keysByFile,
	manifest,
);
const eagerJs = reportAssets(
	Array.from(eagerFiles).filter((file) => file.endsWith('.js')),
	keysByFile,
	manifest,
);
const eagerCss = reportAssets(eagerCssFiles, keysByFile, manifest);
const allJs = reportAssets(
	collectFiles(buildRoot)
		.filter((file) => file.endsWith('.js'))
		.map((file) => path.relative(buildRoot, file)),
	keysByFile,
	manifest,
);

const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
	cwd: path.resolve(webRoot, '..'),
}).stdout.toString().trim();

console.log(
	JSON.stringify(
		{
			revision,
			versions: {
				bun: Bun.version,
				vite: packageVersion('vite'),
				svelte: packageVersion('svelte'),
			},
			preloadedJs: { count: preloadJs.length, bytes: sumBytes(preloadJs), assets: preloadJs },
			eagerJs: { count: eagerJs.length, bytes: sumBytes(eagerJs), assets: eagerJs },
			eagerCss: { count: eagerCss.length, bytes: sumBytes(eagerCss), assets: eagerCss },
			allJs: { count: allJs.length, bytes: sumBytes(allJs) },
		},
		null,
		2,
	),
);
