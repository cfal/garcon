import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';
import { applyWorkflowSourceChanges } from '../workflow-editor-source';

it('changes only the edited source bytes even with mixed newline styles', () => {
	const source = '# workflow\r\nname: Old\nversion: 1\r\n';
	const state = EditorState.create({ doc: source });
	const from = state.doc.line(2).from + 'name: '.length;
	const transaction = state.update({ changes: { from, to: from + 3, insert: 'New' } });
	expect(applyWorkflowSourceChanges(source, state.doc, transaction.changes)).toBe(
		'# workflow\r\nname: New\nversion: 1\r\n',
	);
});
