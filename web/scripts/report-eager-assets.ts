import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { renderRuntimeShell } from '../../common/runtime-shell.js';
import { assertEagerAssetBudget, assertLazyRendererAssets, collectEagerAssets, linkedAssets, type ManifestEntry } from './eager-assets.js';

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
const html = renderRuntimeShell(readFileSync(indexPath, 'utf8'), '');
const preloadFiles = linkedAssets(html, 'modulepreload');
const { files: eagerFiles, cssFiles: eagerCssFiles, keysByFile } = collectEagerAssets(
	preloadFiles, linkedAssets(html, 'stylesheet'), manifest,
);

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
const workspaceEntry = Object.values(manifest).find(({ name }) => name === 'WorkspaceBoot');
if (process.argv.includes('--check')) {
	assertLazyRendererAssets(eagerJs);
	if (!workspaceEntry || eagerFiles.has(workspaceEntry.file)) {
		throw new Error('Authenticated workspace must remain outside the public shell');
	}
	const workspace = collectEagerAssets([workspaceEntry.file], [], manifest);
	const workspaceJs = reportAssets([...workspace.files].filter((file) => file.endsWith('.js')), keysByFile, manifest);
	assertLazyRendererAssets(workspaceJs, 'workspace');
	assertEagerAssetBudget(sumBytes(eagerJs), sumBytes(eagerCss));
}
const worker = readFileSync(path.join(buildRoot, 'service-worker.js'), 'utf8');
const precacheJson = worker.split('\n', 1)[0].match(/^const __GARCON_PRECACHE__ = (.*);$/)?.[1];
if (!precacheJson) throw new Error('Service worker is missing the eager precache manifest');
const { eager } = JSON.parse(precacheJson) as { eager: string[] };
const precachedAssets = reportAssets(['index.html', ...eager], keysByFile, manifest);
if (process.argv.includes('--check')) assertLazyRendererAssets(precachedAssets);
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
			precachedShell: { count: precachedAssets.length, bytes: sumBytes(precachedAssets) },
			allJs: { count: allJs.length, bytes: sumBytes(allJs) },
		},
		null,
		2,
	),
);
