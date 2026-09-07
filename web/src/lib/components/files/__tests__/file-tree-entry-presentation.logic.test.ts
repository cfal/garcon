import { describe, expect, it } from 'vitest';
import type { FileTreeEntry } from '$shared/file-contracts';
import {
	fileTreeFieldLabel,
	formatFileTreeModified,
	formatFileTreeSize,
	presentFileTreeDetail,
} from '../file-tree-entry-presentation.js';

function entry(type: FileTreeEntry['type'], extra: Partial<FileTreeEntry> = {}): FileTreeEntry {
	return {
		name: type === 'file' ? 'README.md' : 'src',
		path: type === 'file' ? '/workspace/README.md' : '/workspace/src',
		relativePath: type === 'file' ? 'README.md' : 'src',
		type,
		size: type === 'file' ? 1_536 : 4_096,
		modified: '2026-07-31T10:00:00.000Z',
		permissionsRwx: type === 'file' ? 'rw-r--r--' : 'rwxr-xr-x',
		...extra,
	};
}

describe('file tree entry presentation', () => {
	it('formats file sizes at stable unit boundaries', () => {
		expect(formatFileTreeSize(0)).toBe('0 B');
		expect(formatFileTreeSize(1_536)).toBe('1.5 KB');
		expect(formatFileTreeSize(1024 ** 5)).toBe('1024 TB');
	});

	it('formats modified times deterministically', () => {
		const now = Date.parse('2026-07-31T12:00:00.000Z');

		expect(formatFileTreeModified('2026-07-31T10:00:00.000Z', now)).toBe('2 hours ago');
		expect(formatFileTreeModified(null, now)).toBeNull();
		expect(formatFileTreeModified('invalid', now)).toBeNull();
	});

	it('omits directory size and unavailable metadata', () => {
		const directory = entry('directory', {
			modified: null,
			permissionsRwx: '',
		});

		expect(presentFileTreeDetail(directory, 'size').value).toBeNull();
		expect(presentFileTreeDetail(directory, 'modified').value).toBeNull();
		expect(presentFileTreeDetail(directory, 'permissions').value).toBeNull();
	});

	it('marks permissions as monospace and centralizes field labels', () => {
		const permissions = presentFileTreeDetail(entry('file'), 'permissions');

		expect(permissions).toMatchObject({ value: 'rw-r--r--', monospace: true });
		expect(fileTreeFieldLabel('name')).toBe('Name');
		expect(fileTreeFieldLabel('modified')).toBe('Modified');
	});
});
