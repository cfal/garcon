import { describe, expect, it } from 'vitest';
import {
	resolveFileLinkFromFile,
	resolveFileLinkTarget,
} from '$lib/chat/file-links/file-link-resolver.js';

const opts = {
	fileRootPath: '/workspace',
	sourceDirectoryPath: '/workspace/current',
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
				fileRootPath: '/workspace',
				sourceDirectoryPath: '/tmp/current',
			}),
		).toBeNull();
	});
});

describe('resolveFileLinkFromFile', () => {
	const fileOpts = {
		fileRootPath: '/workspace/project',
		sourceFilePath: 'docs/guides/current.md',
	};

	it.each([
		['current.md', 'docs/guides/current.md'],
		['sibling.md', 'docs/guides/sibling.md'],
		['child/topic.md', 'docs/guides/child/topic.md'],
		['../README.md', 'docs/README.md'],
		['../../README.md', 'README.md'],
		['/workspace/project/assets/logo.png', 'assets/logo.png'],
		['encoded%20name.md', 'docs/guides/encoded name.md'],
	] as const)('resolves %s relative to the containing file', (href, relativePath) => {
		expect(resolveFileLinkFromFile(href, fileOpts)).toMatchObject({
			fileRootPath: '/workspace/project',
			relativePath,
		});
	});

	it('preserves line and column suffixes', () => {
		expect(resolveFileLinkFromFile('../src/main.ts:42:7', fileOpts)).toMatchObject({
			relativePath: 'docs/src/main.ts',
			line: 42,
			col: 7,
		});
		expect(resolveFileLinkFromFile('../src/main.ts#L15', fileOpts)).toMatchObject({
			relativePath: 'docs/src/main.ts',
			line: 15,
		});
	});

	it.each([
		'../../../outside.md',
		'..%2F..%2F..%2Foutside.md',
		'/tmp/outside.md',
		'https://example.com/file.md',
		'file:///workspace/project/README.md',
		'javascript:alert(1)',
		'//example.com/file.md',
		'',
		'.',
		'%ZZ',
	])('rejects an unsafe or non-file href: %s', (href) => {
		expect(resolveFileLinkFromFile(href, fileOpts)).toBeNull();
	});

	it.each(['../../../outside.md', '/tmp/source.md', '.'])(
		'rejects a source file path outside the canonical root: %s',
		(sourceFilePath) => {
			expect(
				resolveFileLinkFromFile('README.md', {
					fileRootPath: '/workspace/project',
					sourceFilePath,
				}),
			).toBeNull();
		},
	);

	it('supports Windows roots and separators', () => {
		const windowsOpts = {
			fileRootPath: 'C:\\workspace\\project',
			sourceFilePath: 'docs\\guide.md',
		};

		expect(resolveFileLinkFromFile('sibling.md', windowsOpts)).toMatchObject({
			fileRootPath: 'C:/workspace/project',
			relativePath: 'docs/sibling.md',
		});
		expect(resolveFileLinkFromFile('C:\\workspace\\project\\README.md', windowsOpts)).toMatchObject(
			{ relativePath: 'README.md' },
		);
		expect(resolveFileLinkFromFile('C:/Windows/system.ini', windowsOpts)).toBeNull();
	});

	it('preserves a Windows drive root', () => {
		expect(
			resolveFileLinkFromFile('../README.md', {
				fileRootPath: 'C:\\',
				sourceFilePath: 'docs\\guide.md',
			}),
		).toMatchObject({
			fileRootPath: 'C:/',
			relativePath: 'README.md',
		});
	});
});
