export interface FileTextMetadata {
	lineSeparator: '\n' | '\r' | '\r\n';
	mixedLineEndings: boolean;
}

export function fileTextMetadata(content: string): FileTextMetadata {
	const withoutCrLf = content.replaceAll('\r\n', '');
	let lineSeparator: FileTextMetadata['lineSeparator'] = '\n';
	if (content.includes('\r\n')) {
		lineSeparator = '\r\n';
	} else if (content.includes('\r')) {
		lineSeparator = '\r';
	}
	const kinds =
		Number(content.includes('\r\n')) +
		Number(withoutCrLf.includes('\r')) +
		Number(withoutCrLf.includes('\n'));
	return { lineSeparator, mixedLineEndings: kinds > 1 };
}
