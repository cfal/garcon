import { describe, it, expect } from 'vitest';
import { FileViewerStore, resolveViewerMode } from '../file-viewer.svelte';

describe('resolveViewerMode', () => {
	it('defaults markdown files to markdown mode', () => {
		expect(resolveViewerMode('README.md', 'auto')).toBe('markdown');
	});

	it('recognizes .markdown extension', () => {
		expect(resolveViewerMode('docs/guide.markdown', 'auto')).toBe('markdown');
	});

	it('defaults image files to image mode', () => {
		expect(resolveViewerMode('logo.png', 'auto')).toBe('image');
		expect(resolveViewerMode('photo.jpg', 'auto')).toBe('image');
		expect(resolveViewerMode('icon.svg', 'auto')).toBe('image');
		expect(resolveViewerMode('banner.webp', 'auto')).toBe('image');
	});

	it('defaults non-markdown text files to code mode', () => {
		expect(resolveViewerMode('src/app.ts', 'auto')).toBe('code');
		expect(resolveViewerMode('Makefile', 'auto')).toBe('code');
	});

	it('honors explicit mode override', () => {
		expect(resolveViewerMode('README.md', 'code')).toBe('code');
		expect(resolveViewerMode('app.ts', 'markdown')).toBe('markdown');
		expect(resolveViewerMode('app.ts', 'image')).toBe('image');
	});

	it('handles paths without extensions', () => {
		expect(resolveViewerMode('Dockerfile', 'auto')).toBe('code');
	});

	it('handles nested paths', () => {
		expect(resolveViewerMode('docs/api/reference.md', 'auto')).toBe('markdown');
		expect(resolveViewerMode('assets/images/logo.png', 'auto')).toBe('image');
	});
});

describe('FileViewerStore', () => {
	it('starts with no pending request', () => {
		const store = new FileViewerStore();
		expect(store.pending).toBeNull();
	});

	it('queues and consumes open requests via openAuto', () => {
		const store = new FileViewerStore();
		store.openAuto({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'README.md',
			source: 'markdown-link',
		});

		expect(store.pending).not.toBeNull();
		expect(store.pending!.relativePath).toBe('README.md');
		expect(store.pending!.preferredMode).toBe('auto');
		expect(store.pending!.requestedAt).toBeGreaterThan(0);

		const req = store.consumePending();
		expect(req?.relativePath).toBe('README.md');
		expect(store.pending).toBeNull();
	});

	it('sets correct preferred mode for openCode', () => {
		const store = new FileViewerStore();
		store.openCode({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'README.md',
			source: 'files-tree',
		});
		expect(store.pending!.preferredMode).toBe('code');
	});

	it('sets correct preferred mode for openMarkdown', () => {
		const store = new FileViewerStore();
		store.openMarkdown({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'app.ts',
			source: 'command',
		});
		expect(store.pending!.preferredMode).toBe('markdown');
	});

	it('sets correct preferred mode for openImage', () => {
		const store = new FileViewerStore();
		store.openImage({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'logo.png',
			source: 'tool',
		});
		expect(store.pending!.preferredMode).toBe('image');
	});

	it('latest request overwrites previous', () => {
		const store = new FileViewerStore();
		store.openAuto({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'first.ts',
			source: 'markdown-link',
		});
		store.openAuto({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'second.ts',
			source: 'tool',
		});
		expect(store.pending!.relativePath).toBe('second.ts');
		expect(store.pending!.source).toBe('tool');
	});

	it('consumePending returns null when no request pending', () => {
		const store = new FileViewerStore();
		expect(store.consumePending()).toBeNull();
	});

	it('preserves optional line and col fields', () => {
		const store = new FileViewerStore();
		store.openAuto({
			chatId: 'chat-1',
			projectPath: '/repo',
			relativePath: 'file.ts',
			source: 'markdown-link',
			line: 42,
			col: 10,
		});
		const req = store.consumePending();
		expect(req!.line).toBe(42);
		expect(req!.col).toBe(10);
	});
});
