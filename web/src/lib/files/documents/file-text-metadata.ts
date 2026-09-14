export interface FileTextMetadata {
	lineSeparator: '\n' | '\r' | '\r\n';
	mixedLineEndings: boolean;
}

export function fileTextMetadata(content: string): FileTextMetadata {
	const withoutCrLf = content.replaceAll('\r\n', '');
	const hasCrLf = content.includes('\r\n');
	const hasCr = withoutCrLf.includes('\r');
	const hasLf = withoutCrLf.includes('\n');
	let lineSeparator: FileTextMetadata['lineSeparator'] = '\n';
	if (hasCrLf) {
		lineSeparator = '\r\n';
	} else if (hasCr) {
		lineSeparator = '\r';
	}
	const kinds = Number(hasCrLf) + Number(hasCr) + Number(hasLf);
	return { lineSeparator, mixedLineEndings: kinds > 1 };
}
