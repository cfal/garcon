export interface CodeHighlightSegment {
	text: string;
	className: string | null;
}

export function plainCodeSegments(text: string): CodeHighlightSegment[] {
	return text ? [{ text, className: null }] : [];
}
