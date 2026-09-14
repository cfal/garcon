import { render } from '@testing-library/svelte';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import FileConflictDiffTestHost from './FileConflictDiffTestHost.svelte';

describe('FileConflictDiff', () => {
	it('projects edits from the resolution pane to its bound content', async () => {
		const onChange = vi.fn();
		const rendered = render(FileConflictDiffTestHost, { onChange });
		await vi.waitFor(() =>
			expect(rendered.container.querySelectorAll('.cm-editor')).toHaveLength(2),
		);
		const editors = rendered.container.querySelectorAll<HTMLElement>('.cm-editor');
		const snapshot = EditorView.findFromDOM(editors[0]!);
		const resolution = EditorView.findFromDOM(editors[1]!);
		if (!snapshot || !resolution) throw new Error('Expected comparison editors');
		expect(snapshot.state.readOnly).toBe(true);
		expect(snapshot.contentDOM.contentEditable).toBe('false');
		expect(snapshot.contentDOM.getAttribute('aria-label')).toBe('Comparison snapshot');
		expect(resolution.state.readOnly).toBe(false);
		expect(resolution.contentDOM.contentEditable).toBe('true');
		expect(resolution.contentDOM.getAttribute('aria-label')).toBe('Resolution copy');

		resolution.dispatch({
			changes: { from: 0, to: resolution.state.doc.length, insert: 'merged' },
		});

		await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('merged'));
	});

	it('preserves the captured line separator when the resolution changes', async () => {
		const onChange = vi.fn();
		const rendered = render(FileConflictDiffTestHost, {
			onChange,
			initialLocal: 'a\r\nb',
			lineSeparator: '\r\n',
		});
		await vi.waitFor(() =>
			expect(rendered.container.querySelectorAll('.cm-editor')).toHaveLength(2),
		);
		const editors = rendered.container.querySelectorAll<HTMLElement>('.cm-editor');
		const resolution = EditorView.findFromDOM(editors[1]!);
		if (!resolution) throw new Error('Expected resolution editor');

		resolution.dispatch({
			changes: { from: resolution.state.doc.length, insert: ' local!' },
		});

		await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('a\r\nb local!'));
	});
});
