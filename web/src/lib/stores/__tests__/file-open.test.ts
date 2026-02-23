import { describe, it, expect } from 'vitest';
import { FileOpenStore } from '../file-open.svelte';

describe('FileOpenStore', () => {
	it('starts with no pending request', () => {
		const store = new FileOpenStore();
		expect(store.pending).toBeNull();
	});

	it('sets a pending request via requestOpenFile', () => {
		const store = new FileOpenStore();
		store.requestOpenFile('chat-1', 'src/main.ts', 'markdown');

		expect(store.pending).not.toBeNull();
		expect(store.pending!.chatId).toBe('chat-1');
		expect(store.pending!.relativePath).toBe('src/main.ts');
		expect(store.pending!.source).toBe('markdown');
		expect(store.pending!.requestedAt).toBeGreaterThan(0);
	});

	it('consumeForChat returns and clears matching request', () => {
		const store = new FileOpenStore();
		store.requestOpenFile('chat-1', 'README.md', 'tool');

		const req = store.consumeForChat('chat-1');
		expect(req).not.toBeNull();
		expect(req!.relativePath).toBe('README.md');
		expect(store.pending).toBeNull();
	});

	it('consumeForChat returns null for non-matching chatId', () => {
		const store = new FileOpenStore();
		store.requestOpenFile('chat-1', 'file.ts', 'markdown');

		const req = store.consumeForChat('chat-2');
		expect(req).toBeNull();
		expect(store.pending).not.toBeNull();
	});

	it('latest request overwrites previous', () => {
		const store = new FileOpenStore();
		store.requestOpenFile('chat-1', 'first.ts', 'markdown');
		store.requestOpenFile('chat-1', 'second.ts', 'tool');

		expect(store.pending!.relativePath).toBe('second.ts');
		expect(store.pending!.source).toBe('tool');
	});
});
