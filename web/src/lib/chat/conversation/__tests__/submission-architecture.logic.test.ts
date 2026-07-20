import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
		return /\.(?:svelte|ts)$/.test(entry.name) ? [path] : [];
	});
}

describe('accepted input submission boundaries', () => {
	it('keeps accepted input transports out of UI components', () => {
		for (const file of sourceFiles('src/lib/components')) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(
				/\b(?:createQueuedInput|forkRunChat|runChat|sendActiveInput|startChat)\b/,
			);
		}
	});

	it('keeps accepted input transports inside the submission service', () => {
		for (const file of sourceFiles('src/lib/chat/conversation')) {
			if (file.endsWith('accepted-input-submission-service.ts')) continue;
			expect(readFileSync(file, 'utf8'), file).not.toMatch(
				/\b(?:createQueuedInput|forkRunChat|runChat|sendActiveInput|startChat)\b/,
			);
		}
	});
});
