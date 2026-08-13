export interface CodeHighlightSegment {
	text: string;
	className: string | null;
}

export function appendCodeHighlightSegment(
	segments: CodeHighlightSegment[],
	text: string,
	className: string | null,
): void {
	if (!text) return;

	const normalizedClassName = className || null;
	const previous = segments.at(-1);
	if (previous?.className === normalizedClassName) {
		previous.text += text;
		return;
	}

	segments.push({ text, className: normalizedClassName });
}

export function plainCodeSegments(text: string): CodeHighlightSegment[] {
	return text ? [{ text, className: null }] : [];
}
