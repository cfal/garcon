const IMAGE_FILE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'svg',
	'webp',
	'ico',
	'bmp',
]);

export function fileExtension(filePath: string): string {
	const fileName = filePath.split('/').pop() ?? filePath;
	return fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';
}

export function isImageFilePath(filePath: string): boolean {
	return IMAGE_FILE_EXTENSIONS.has(fileExtension(filePath));
}
