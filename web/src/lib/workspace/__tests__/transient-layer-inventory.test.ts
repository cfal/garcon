import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CUSTOM_TRANSIENT_SOURCES,
	GLOBAL_KEYBOARD_OWNER,
	TRANSIENT_BACKDROP_SOURCES,
	TRANSIENT_PRIMITIVE_CONTENT,
} from './transient-layer-inventory.js';

const sourceRoot = join(process.cwd(), 'src/lib');

function productionSources(directory = sourceRoot): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (entry === '__tests__') return [];
		if (statSync(path).isDirectory()) return productionSources(path);
		return /\.(svelte|ts)$/.test(entry) ? [path] : [];
	});
}

function source(path: string): string {
	return readFileSync(join(sourceRoot, path), 'utf8');
}

describe('transient layer inventory', () => {
	it('keeps one global keyboard listener', () => {
		const owners = productionSources()
			.filter((path) =>
				/window\.addEventListener\(['"]keydown|<svelte:window[^>]*onkeydown/.test(
					readFileSync(path, 'utf8'),
				),
			)
			.map((path) => relative(sourceRoot, path));

		expect(owners).toEqual([GLOBAL_KEYBOARD_OWNER]);
	});

	it('registers every shared transient primitive', () => {
		for (const path of TRANSIENT_PRIMITIVE_CONTENT) {
			const contents = source(path);
			expect(contents, path).toContain('getOptionalTransientLayers');
			expect(contents, path).toContain('transientLayers.register');
		}
	});

	it('keeps every custom transient in the typed registry', () => {
		for (const path of CUSTOM_TRANSIENT_SOURCES) {
			const contents = source(path);
			expect(contents, path).toContain('transientLayer');
			expect(contents, path).toContain('registry: transientLayers');
		}
	});

	it('keeps modal backdrops on the shared visual treatment', () => {
		for (const path of TRANSIENT_BACKDROP_SOURCES) {
			const contents = source(path);
			expect(contents, path).toContain('transient-backdrop');
			expect(contents, path).not.toMatch(/bg-(?:black|foreground)\/(?:40|50)/);
			expect(contents, path).not.toContain('backdrop-blur-sm');
		}
	});

	it('does not restore DOM-query escape ownership', () => {
		for (const path of productionSources()) {
			const contents = readFileSync(path, 'utf8');
			expect(contents, relative(sourceRoot, path)).not.toMatch(
				/querySelector(All)?[^\n]*(data-escape-dismiss-layer|data-slot=.dialog-content|bits-dialog)/,
			);
		}
	});
});
