export interface FileMentionTrigger {
	start: number;
	end: number;
	query: string;
}

export interface FileMentionReplacement {
	text: string;
	caret: number;
}

const FILE_TRIGGER_RE = /(^|\s)@([^\s]*)$/;

export function findFileMentionTrigger(value: string, caret: number): FileMentionTrigger | null {
	const boundedCaret = Math.max(0, Math.min(caret, value.length));
	const prefix = value.slice(0, boundedCaret);
	const match = prefix.match(FILE_TRIGGER_RE);
	if (!match || match.index === undefined) return null;
	const leadingWhitespace = match[1] ?? '';
	return {
		start: match.index + leadingWhitespace.length,
		end: boundedCaret,
		query: match[2] ?? '',
	};
}

export function formatFileMentionPath(path: string): string {
	return /\s/.test(path) ? JSON.stringify(path) : path;
}

export function applyFileMention(
	value: string,
	trigger: FileMentionTrigger,
	path: string,
): FileMentionReplacement {
	const token = `@${formatFileMentionPath(path)}`;
	const before = value.slice(0, trigger.start);
	const after = value.slice(trigger.end);
	const preservesLineBreak = /^\r?\n/.test(after);
	const separator = preservesLineBreak ? '' : ' ';
	const remainder = preservesLineBreak ? after : after.replace(/^[ \t]+/, '');
	const text = `${before}${token}${separator}${remainder}`;
	return {
		text,
		caret: before.length + token.length + separator.length,
	};
}
