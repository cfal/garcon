export interface FileTextMetadata {
	lineSeparator: '\n' | '\r' | '\r\n';
	mixedLineEndings: boolean;
}

export function fileTextMetadata(content: string): FileTextMetadata {
	const withoutCrLf = content.replaceAll('\r\n', '');
	const lineSeparator = content.includes('\r\n')
		? '\r\n'
		: content.includes('\r')
			? '\r'
			: '\n';
	const kinds =
		Number(content.includes('\r\n')) +
		Number(withoutCrLf.includes('\r')) +
		Number(withoutCrLf.includes('\n'));
	return { lineSeparator, mixedLineEndings: kinds > 1 };
}
