import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import {
	FileDocumentRuntime,
	type FileDocumentViewAdapter,
} from '$lib/files/editor/file-document-runtime.js';

function document() {
	const value = new FileDocumentState(
		{ canonicalFileRootPath: '/workspace', normalizedRelativePath: 'src/file.ts' },
		'["/workspace","src/file.ts"]',
	);
	value.baseline = 'abc';
	return value;
}

function adapter(id: string, doc = 'abc', anchor = doc.length, readOnly = false) {
	let current = EditorState.create({
		doc,
		selection: { anchor },
		extensions: readOnly ? [EditorState.readOnly.of(true)] : [],
	});
	const value: FileDocumentViewAdapter = {
		id,
		currentState: () => current,
		applySourceTransactions(transactions) {
			current = transactions.at(-1)?.state ?? current;
		},
		applyDocumentSpec(spec) {
			current = current.update(spec).state;
		},
		replaceDocument(spec) {
			current = current.update(spec).state;
		},
	};
	return { value, state: () => current };
}

describe('FileDocumentRuntime', () => {
	it('rejects a stale transaction anywhere in a batch before mutating any owner', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const first = adapter('first');
		const second = adapter('second');
		runtime.register(first.value);
		runtime.register(second.value);
		const changed = vi.fn();
		value.onChange(changed);
		const version = value.bufferVersion;
		const initial = first.state();
		const valid = initial.update({ changes: { from: 3, insert: 'valid' } });
		const stale = initial.update({ changes: { from: 0, insert: 'stale' } });

		runtime.dispatchSource(first.value, [valid, stale]);

		expect(runtime.content()).toBe('abc');
		expect(first.state()).toBe(initial);
		expect(second.state().doc.toString()).toBe('abc');
		expect(value.bufferVersion).toBe(version);
		expect(value.dirty).toBe(false);
		expect(changed).not.toHaveBeenCalled();
	});

	it('keeps unchanged cursor positions between separated disk edits', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'aX-middle-Yz');
		const view = adapter('view', 'aX-middle-Yz', 6);
		runtime.register(view.value);
		runtime.replaceFromDisk('aXX-middle-YYz');
		expect(view.state().selection.main.head).toBe(7);
	});

	it('serializes canonical changes only on demand and caches the result', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const content = vi.spyOn(runtime, 'content');

		runtime.applyUserEdit('abcd');

		expect(content).not.toHaveBeenCalled();
		expect(value.dirty).toBe(true);
		const serialize = vi.spyOn(runtime.canonicalState.doc, 'toString');
		expect(value.currentContent()).toBe('abcd');
		expect(value.content).toBe('abcd');
		expect(serialize).toHaveBeenCalledOnce();
		value.content = 'abc';
		expect(value.currentContent()).toBe('abc');
		expect(value.dirty).toBe(false);
		content.mockRestore();
	});

	it.each(['', 'a\nb\n', 'a\rb\r', 'a\r\nb\r\n', 'a\rb\r\nc\n'])(
		'normalizes %j with the same line boundaries as CodeMirror',
		(content) => {
			const runtime = new FileDocumentRuntime(document(), content);
			const expected = EditorState.create({ doc: content }).doc;

			expect(runtime.canonicalState.doc.eq(expected)).toBe(true);
			runtime.replaceFromDisk(`prefix\r\n${content}`);
			expect(
				runtime.canonicalState.doc.eq(EditorState.create({ doc: `prefix\r\n${content}` }).doc),
			).toBe(true);
		},
	);

	it('converges alternating view edits and isolates their undo groups', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const first = adapter('first');
		const second = adapter('second');
		runtime.register(first.value);
		runtime.register(second.value);

		runtime.dispatchSource(first.value, [
			first.state().update({ changes: { from: 3, insert: '1' }, userEvent: 'input.type' }),
		]);
		runtime.dispatchSource(second.value, [
			second.state().update({ changes: { from: 4, insert: '2' }, userEvent: 'input.type' }),
		]);

		expect(runtime.content()).toBe('abc12');
		expect(first.state().doc.toString()).toBe('abc12');
		expect(second.state().doc.toString()).toBe('abc12');
		expect(runtime.undo('second')).toBe(true);
		expect(runtime.content()).toBe('abc1');
		expect(runtime.undo('first')).toBe(true);
		expect(runtime.content()).toBe('abc');
		expect(runtime.redo('first')).toBe(true);
		expect(runtime.content()).toBe('abc1');
	});

	it('maps detached logical view selections through another view edit', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const first = adapter('first');
		const second = adapter('second');
		runtime.register(first.value);
		runtime.register(second.value);

		runtime.dispatchSource(second.value, [
			second.state().update({ changes: { from: 0, insert: 'xx' }, userEvent: 'input.type' }),
		]);

		expect(first.state().selection.main.head).toBe(5);
	});

	it('rejects canonical history commands from a read-only view', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const writable = adapter('writable');
		const readOnly = adapter('read-only', 'abc', 3, true);
		runtime.register(writable.value);
		runtime.register(readOnly.value);
		runtime.dispatchSource(writable.value, [
			writable.state().update({ changes: { from: 3, insert: '1' }, userEvent: 'input.type' }),
		]);

		expect(runtime.undo('read-only')).toBe(false);
		expect(runtime.redo('read-only')).toBe(false);
		expect(runtime.content()).toBe('abc1');
	});

	it('applies conflict resolutions as isolated undoable edits', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const first = adapter('first');
		runtime.register(first.value);
		runtime.dispatchSource(first.value, [
			first.state().update({ changes: { from: 3, insert: '1' }, userEvent: 'input.type' }),
		]);

		runtime.applyUserEdit('merged');

		expect(runtime.content()).toBe('merged');
		expect(runtime.undo('first')).toBe(true);
		expect(runtime.content()).toBe('abc1');
		expect(runtime.undo('first')).toBe(true);
		expect(runtime.content()).toBe('abc');
	});

	it('rejects stale adapter transactions before canonical mutation', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const first = adapter('first');
		const unregister = runtime.register(first.value);
		const stale = first.state().update({ changes: { from: 0, insert: 'stale' } });
		unregister();

		runtime.dispatchSource(first.value, [stale]);

		expect(runtime.content()).toBe('abc');
	});

	it('marks mixed line endings without pretending normalized text is lossless', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'a\r\nb\nc');

		expect(value.mixedLineEndings).toBe(true);
		expect(runtime.content()).not.toBe('a\r\nb\nc');
	});

	it('preserves CRLF serialization through edits', () => {
		const value = document();
		value.baseline = 'a\r\nb';
		const runtime = new FileDocumentRuntime(value, 'a\r\nb');
		const first = adapter('first', 'a\nb');
		runtime.register(first.value);

		runtime.dispatchSource(first.value, [
			first.state().update({ changes: { from: 3, insert: '!' }, userEvent: 'input.type' }),
		]);

		expect(runtime.content()).toBe('a\r\nb!');
	});

	it('maps selections through automatic disk changes', () => {
		const value = document();
		const initial = 'one\ntwo\nthree';
		value.baseline = initial;
		const runtime = new FileDocumentRuntime(value, initial);
		const first = adapter('first', initial, 4);
		runtime.register(first.value);

		runtime.replaceFromDisk(`zero\n${initial}`);

		expect(first.state().selection.main.head).toBe(9);
		expect(first.state().sliceDoc(9, 12)).toBe('two');
	});

	it('keeps an end cursor associated with whole-document replacement content', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const atEnd = adapter('at-end', 'abc');
		runtime.register(atEnd.value);

		runtime.replaceFromDisk('replacement');

		expect(atEnd.state().selection.main.head).toBe('replacement'.length);
	});

	it('keeps a start cursor associated with original content after a disk prepend', () => {
		const value = document();
		const runtime = new FileDocumentRuntime(value, 'abc');
		const atStart = adapter('at-start', 'abc', 0);
		runtime.register(atStart.value);

		const prefix = 'before ';
		runtime.replaceFromDisk(`${prefix}abc`);

		expect(atStart.state().selection.main.head).toBe(prefix.length);
	});
});
