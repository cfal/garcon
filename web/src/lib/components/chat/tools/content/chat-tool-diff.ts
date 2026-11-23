export const MAX_CHAT_TOOL_DIFF_CHARS = 200_000;
export const MAX_CHAT_TOOL_DIFF_LINES = 5_000;
export const MAX_CHAT_TOOL_DIFF_MATRIX_CELLS = 250_000;

export interface ChatToolDiffLine {
	type: 'added' | 'removed';
	content: string;
	lineNum: number;
}

export type ChatToolDiff = { kind: 'ready'; lines: ChatToolDiffLine[] } | { kind: 'too-large' };

function countLinesWithinBudget(text: string, remaining: number): number | null {
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) !== 10) continue;
		lines += 1;
		if (lines > remaining) return null;
	}
	return lines;
}

function isWithinDiffBudget(oldContent: string, newContent: string): boolean {
	if (oldContent.length + newContent.length > MAX_CHAT_TOOL_DIFF_CHARS) return false;

	const oldLineCount = countLinesWithinBudget(oldContent, MAX_CHAT_TOOL_DIFF_LINES);
	if (oldLineCount === null) return false;
	const newLineCount = countLinesWithinBudget(newContent, MAX_CHAT_TOOL_DIFF_LINES - oldLineCount);
	if (newLineCount === null) return false;
	if ((oldLineCount + 1) * (newLineCount + 1) > MAX_CHAT_TOOL_DIFF_MATRIX_CELLS) {
		return false;
	}

	return true;
}

export function buildChatToolDiff(oldContent: string, newContent: string): ChatToolDiff {
	if (!isWithinDiffBudget(oldContent, newContent)) return { kind: 'too-large' };

	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > 0 && newEnd > 0 && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd -= 1;
		newEnd -= 1;
	}
	let prefix = 0;
	while (prefix < oldEnd && prefix < newEnd && oldLines[prefix] === newLines[prefix]) {
		prefix += 1;
	}

	const width = newEnd - prefix + 1;
	const lengths: number[][] = Array.from({ length: oldEnd - prefix + 1 }, () =>
		Array(width).fill(0),
	);

	for (let i = 1; i < lengths.length; i += 1) {
		const previous = lengths[i - 1];
		const row = lengths[i];
		const oldLine = oldLines[prefix + i - 1];
		for (let j = 1; j < width; j += 1) {
			row[j] = oldLine === newLines[prefix + j - 1]
				? previous[j - 1] + 1
				: Math.max(previous[j], row[j - 1]);
		}
	}

	// Backtracking may match a duplicate across the shared prefix. Inside that
	// prefix the shorter sequence is already a subsequence of the longer one.
	function lengthAt(i: number, j: number): number {
		if (i <= prefix || j <= prefix) return Math.min(i, j);
		return prefix + lengths[i - prefix][j - prefix];
	}

	const reversed: ChatToolDiffLine[] = [];
	let oldIndex = oldEnd;
	let newIndex = newEnd;
	while (oldIndex > 0 || newIndex > 0) {
		if (oldIndex > 0 && newIndex > 0 && oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
			oldIndex -= 1;
			newIndex -= 1;
		} else if (
			newIndex > 0 &&
			(oldIndex === 0 || lengthAt(oldIndex, newIndex - 1) >= lengthAt(oldIndex - 1, newIndex))
		) {
			reversed.push({
				type: 'added',
				content: newLines[newIndex - 1],
				lineNum: newIndex,
			});
			newIndex -= 1;
		} else {
			reversed.push({
				type: 'removed',
				content: oldLines[oldIndex - 1],
				lineNum: oldIndex,
			});
			oldIndex -= 1;
		}
	}

	return { kind: 'ready', lines: reversed.reverse() };
}
