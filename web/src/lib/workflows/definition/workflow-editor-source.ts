import type { ChangeSet, Text } from '@codemirror/state';

export function applyWorkflowSourceChanges(source: string, doc: Text, changes: ChangeSet): string {
	const lineStarts = [
		0,
		...Array.from(source.matchAll(/\r\n|\r|\n/g), (match) => match.index + match[0].length),
	];
	const separator = source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
	const offset = (position: number) => {
		const line = doc.lineAt(position);
		return lineStarts[line.number - 1] + position - line.from;
	};
	const parts: string[] = [];
	let cursor = 0;
	changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
		parts.push(source.slice(cursor, offset(from)), inserted.sliceString(0, undefined, separator));
		cursor = offset(to);
	});
	parts.push(source.slice(cursor));
	return parts.join('');
}
