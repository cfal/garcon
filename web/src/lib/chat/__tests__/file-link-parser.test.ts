import { describe, it, expect } from 'vitest';
import { parseFileLink, isFileLink } from '../file-link-parser';

describe('parseFileLink', () => {
	describe('accepts relative file paths', () => {
		it('simple filename', () => {
			const result = parseFileLink('README.md');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('README.md');
		});

		it('nested path', () => {
			const result = parseFileLink('src/lib/utils.ts');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/lib/utils.ts');
		});

		it('dot-relative path', () => {
			const result = parseFileLink('./src/index.ts');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/index.ts');
		});

		it('parent-relative path', () => {
			const result = parseFileLink('../config.json');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('../config.json');
		});

		it('deeply nested parent-relative path', () => {
			const result = parseFileLink('../../lib/foo/bar.ts');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('../../lib/foo/bar.ts');
		});

		it('path with backslashes', () => {
			const result = parseFileLink('src\\lib\\utils.ts');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/lib/utils.ts');
		});

		it('URI-encoded path', () => {
			const result = parseFileLink('src%2Flib%2Futils.ts');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/lib/utils.ts');
		});

		it('path with spaces', () => {
			const result = parseFileLink('my%20folder/file.txt');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('my folder/file.txt');
		});
	});

	describe('ignores absolute paths without base path', () => {
		it('unix absolute path', () => {
			const result = parseFileLink('/etc/passwd');
			expect(result.kind).toBe('ignored');
		});

		it('windows drive letter', () => {
			const result = parseFileLink('C:\\Users\\file.txt');
			expect(result.kind).toBe('ignored');
		});

		it('windows drive with forward slash', () => {
			const result = parseFileLink('D:/projects/foo.ts');
			expect(result.kind).toBe('ignored');
		});
	});

	describe('accepts absolute paths under base path', () => {
		const opts = { projectBasePath: '/home/user/project' };

		it('relativizes file under project root', () => {
			const result = parseFileLink('/home/user/project/src/main.ts', opts);
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/main.ts');
		});

		it('relativizes file directly in project root', () => {
			const result = parseFileLink('/home/user/project/package.json', opts);
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('package.json');
		});

		it('handles projectBasePath with trailing slash', () => {
			const result = parseFileLink('/home/user/project/README.md', { projectBasePath: '/home/user/project/' });
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('README.md');
		});

		it('ignores absolute path outside project root', () => {
			const result = parseFileLink('/etc/passwd', opts);
			expect(result.kind).toBe('ignored');
		});

		it('ignores absolute path that partially matches project prefix', () => {
			const result = parseFileLink('/home/user/project2/foo.ts', opts);
			expect(result.kind).toBe('ignored');
		});

		it('extracts line info from absolute project path', () => {
			const result = parseFileLink('/home/user/project/src/main.ts:42', opts);
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/main.ts');
			expect(result.line).toBe(42);
		});

		it('still works for relative paths when projectBasePath is provided', () => {
			const result = parseFileLink('src/utils.ts', opts);
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/utils.ts');
		});
	});

	describe('ignores URLs with schemes', () => {
		it('https URL', () => {
			const result = parseFileLink('https://example.com/foo');
			expect(result.kind).toBe('ignored');
		});

		it('http URL', () => {
			const result = parseFileLink('http://example.com');
			expect(result.kind).toBe('ignored');
		});

		it('mailto link', () => {
			const result = parseFileLink('mailto:user@example.com');
			expect(result.kind).toBe('ignored');
		});

		it('ftp URL', () => {
			const result = parseFileLink('ftp://files.example.com/f.zip');
			expect(result.kind).toBe('ignored');
		});

		it('custom scheme', () => {
			const result = parseFileLink('vscode://file/path');
			expect(result.kind).toBe('ignored');
		});
	});

	describe('ignores protocol-relative URLs', () => {
		it('protocol-relative URL', () => {
			const result = parseFileLink('//cdn.example.com/lib.js');
			expect(result.kind).toBe('ignored');
		});
	});

	describe('ignores empty and null inputs', () => {
		it('null', () => {
			expect(parseFileLink(null).kind).toBe('ignored');
		});

		it('undefined', () => {
			expect(parseFileLink(undefined).kind).toBe('ignored');
		});

		it('empty string', () => {
			expect(parseFileLink('').kind).toBe('ignored');
		});

		it('whitespace only', () => {
			expect(parseFileLink('   ').kind).toBe('ignored');
		});
	});

	describe('handles query and hash stripping', () => {
		it('strips query string', () => {
			const result = parseFileLink('file.ts?v=123');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('file.ts');
		});

		it('strips hash fragment', () => {
			const result = parseFileLink('file.ts#section');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('file.ts');
		});

		it('strips both query and hash', () => {
			const result = parseFileLink('file.ts?v=1#top');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('file.ts');
		});
	});

	describe('extracts line and column info', () => {
		it(':line suffix', () => {
			const result = parseFileLink('file.ts:42');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('file.ts');
			expect(result.line).toBe(42);
			expect(result.col).toBeUndefined();
		});

		it(':line:col suffix', () => {
			const result = parseFileLink('src/utils.ts:10:5');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/utils.ts');
			expect(result.line).toBe(10);
			expect(result.col).toBe(5);
		});

		it('#Lxx GitHub-style anchor', () => {
			const result = parseFileLink('src/main.rs#L15');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('src/main.rs');
			expect(result.line).toBe(15);
		});

		it('#Lxx-Lyy range anchor', () => {
			const result = parseFileLink('lib/foo.py#L10-L20');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('lib/foo.py');
			expect(result.line).toBe(10);
		});
	});

	describe('edge cases', () => {
		it('dot-only path collapses to ignored', () => {
			expect(parseFileLink('.').kind).toBe('ignored');
		});

		it('multiple dots collapse correctly', () => {
			const result = parseFileLink('./././foo.ts');
			expect(result.kind).toBe('file');
			expect(result.relativePath).toBe('foo.ts');
		});

		it('malformed percent encoding is ignored', () => {
			expect(parseFileLink('%ZZ%ZZ').kind).toBe('ignored');
		});

		it('preserves rawHref', () => {
			const result = parseFileLink('./src/foo.ts');
			expect(result.rawHref).toBe('./src/foo.ts');
		});
	});
});

describe('isFileLink', () => {
	it('returns true for relative paths', () => {
		expect(isFileLink('foo/bar.ts')).toBe(true);
	});

	it('returns false for URLs', () => {
		expect(isFileLink('https://example.com')).toBe(false);
	});

	it('returns false for absolute paths', () => {
		expect(isFileLink('/etc/hosts')).toBe(false);
	});

	it('returns false for null', () => {
		expect(isFileLink(null)).toBe(false);
	});
});
