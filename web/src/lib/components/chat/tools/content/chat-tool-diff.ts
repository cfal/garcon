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
	const oldLineCount = oldLines.length;
	const newLineCount = newLines.length;
	const lengths: number[][] = Array.from({ length: oldLineCount + 1 }, () =>
		Array(newLineCount + 1).fill(0),
	);

	for (let oldIndex = 1; oldIndex <= oldLineCount; oldIndex += 1) {
		for (let newIndex = 1; newIndex <= newLineCount; newIndex += 1) {
			if (oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
				lengths[oldIndex][newIndex] = lengths[oldIndex - 1][newIndex - 1] + 1;
			} else {
				lengths[oldIndex][newIndex] = Math.max(
					lengths[oldIndex - 1][newIndex],
					lengths[oldIndex][newIndex - 1],
				);
			}
		}
	}

	const reversed: ChatToolDiffLine[] = [];
	let oldIndex = oldLineCount;
	let newIndex = newLineCount;
	while (oldIndex > 0 || newIndex > 0) {
		if (oldIndex > 0 && newIndex > 0 && oldLines[oldIndex - 1] === newLines[newIndex - 1]) {
			oldIndex -= 1;
			newIndex -= 1;
		} else if (
			newIndex > 0 &&
			(oldIndex === 0 || lengths[oldIndex][newIndex - 1] >= lengths[oldIndex - 1][newIndex])
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
