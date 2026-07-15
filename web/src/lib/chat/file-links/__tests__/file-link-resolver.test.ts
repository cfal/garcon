import { describe, expect, it } from 'vitest';
import { resolveFileLinkTarget } from '$lib/chat/file-links/file-link-resolver.js';

const opts = {
	projectBasePath: '/workspace',
	chatProjectPath: '/workspace/current',
};

describe('resolveFileLinkTarget', () => {
	it('resolves absolute links under the configured base', () => {
		expect(resolveFileLinkTarget('/workspace/other/README.md', opts)).toMatchObject({
			fileRootPath: '/workspace',
			relativePath: 'other/README.md',
		});
	});

	it('normalizes dot segments in absolute links under the configured base', () => {
		expect(resolveFileLinkTarget('/workspace/current/../shared/README.md', opts)).toMatchObject({
			fileRootPath: '/workspace',
			relativePath: 'shared/README.md',
		});
	});

	it('resolves relative links from the chat project', () => {
		expect(resolveFileLinkTarget('src/main.ts', opts)).toMatchObject({
			fileRootPath: '/workspace',
			relativePath: 'current/src/main.ts',
		});
	});

	it('allows relative links to sibling paths under the configured base', () => {
		expect(resolveFileLinkTarget('../shared/README.md', opts)).toMatchObject({
			fileRootPath: '/workspace',
			relativePath: 'shared/README.md',
		});
	});

	it('rejects paths outside the configured base', () => {
		expect(resolveFileLinkTarget('/tmp/secret.txt', opts)).toBeNull();
		expect(resolveFileLinkTarget('../../tmp/secret.txt', opts)).toBeNull();
	});

	it('preserves line and column suffixes', () => {
		expect(resolveFileLinkTarget('../shared/README.md:42:7', opts)).toMatchObject({
			relativePath: 'shared/README.md',
			line: 42,
			col: 7,
		});
	});

	it('resolves encoded absolute paths', () => {
		expect(resolveFileLinkTarget('%2Fworkspace%2Fshared%20docs%2FREADME.md', opts)).toMatchObject({
			fileRootPath: '/workspace',
			relativePath: 'shared docs/README.md',
		});
	});

	it('rejects links when the chat project is outside the base', () => {
		expect(
			resolveFileLinkTarget('README.md', {
				projectBasePath: '/workspace',
				chatProjectPath: '/tmp/current',
			}),
		).toBeNull();
	});
});
