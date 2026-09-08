import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import {
	browserModuleBoundaryError,
	isForbiddenBrowserRuntimeSpecifier,
	rejectRuntimeBuiltinsFromBrowserBundle,
} from '../../../browser-module-boundary.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function addFixturePackage(root: string, packageName: string): Promise<void> {
	const packageRoot = path.join(root, 'node_modules', packageName);
	await fs.mkdir(packageRoot, { recursive: true });
	await fs.writeFile(
		path.join(packageRoot, 'package.json'),
		JSON.stringify({
			name: packageName,
			version: '1.0.0',
			type: 'module',
			exports: './index.js',
		}),
	);
	await fs.writeFile(path.join(packageRoot, 'index.js'), 'export const portable = true;');
}

async function buildFixture(
	specifier: string,
	consumer: 'client' | 'server',
	fixturePackages: readonly string[] = [],
) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-browser-boundary-'));
	temporaryDirectories.push(root);
	await Promise.all(fixturePackages.map((packageName) => addFixturePackage(root, packageName)));
	const entry = path.join(root, 'entry.ts');
	await fs.writeFile(entry, `import ${JSON.stringify(specifier)}; export const loaded = true;`);

	return build({
		configFile: false,
		root,
		logLevel: 'silent',
		plugins: [rejectRuntimeBuiltinsFromBrowserBundle()],
		build:
			consumer === 'server'
				? { ssr: entry, write: false }
				: {
						lib: { entry, formats: ['es'], fileName: 'fixture' },
						write: false,
					},
	});
}

describe('browser module boundary', () => {
	test.each([
		'bun',
		'bun:sqlite',
		'crypto',
		'fs/promises',
		'node:crypto',
		'node:fs/promises',
		'node:test',
	])('classifies runtime built-in %s', (specifier) => {
		expect(isForbiddenBrowserRuntimeSpecifier(specifier)).toBe(true);
		expect(browserModuleBoundaryError(specifier, '/source/module.ts', 'client')).toContain(
			specifier,
		);
	});

	test.each([
		'./local.js',
		'@garcon/common/chat-types',
		'sea',
		'sqlite',
		'test',
		'test/reporters',
		'vite',
	])('leaves portable specifier %s to Vite', (specifier) => {
		expect(isForbiddenBrowserRuntimeSpecifier(specifier)).toBe(false);
		expect(browserModuleBoundaryError(specifier, '/source/module.ts', 'client')).toBeNull();
	});

	test('does not restrict server environments or entry modules', () => {
		expect(browserModuleBoundaryError('node:crypto', '/source/module.ts', 'server')).toBeNull();
		expect(browserModuleBoundaryError('node:crypto', undefined, 'client')).toBeNull();
	});

	test.each(['node:test', 'bun:sqlite'])(
		'fails a client build that imports %s',
		async (specifier) => {
			await expect(buildFixture(specifier, 'client')).rejects.toThrow(
				`Browser bundle cannot import runtime built-in ${specifier}`,
			);
		},
	);

	test('permits Node built-ins in the server build', async () => {
		await expect(buildFixture('node:path', 'server')).resolves.toBeDefined();
	});

	test('permits an ordinary package whose name exists only behind node:', async () => {
		await expect(buildFixture('test', 'client', ['test'])).resolves.toBeDefined();
	});
});
