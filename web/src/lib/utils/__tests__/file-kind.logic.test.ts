import { describe, expect, it } from 'vitest';
import { fileExtension, isImageFilePath } from '../file-kind.js';

describe('file kind helpers', () => {
	it('normalizes file extensions from names and portable relative paths', () => {
		expect(fileExtension('images/PHOTO.JPEG')).toBe('jpeg');
		expect(fileExtension('README')).toBe('');
		expect(isImageFilePath('images/PHOTO.JPEG')).toBe(true);
		expect(isImageFilePath('src/photo.ts')).toBe(false);
	});
});
