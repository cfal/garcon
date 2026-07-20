import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Guards against god files. Any production source under src/lib over MAX_LINES
// must earn a grandfathered ceiling below. The list only shrinks: when a file
// decomposes to MAX_LINES or fewer, its entry must be removed, and no entry may
// grow past its recorded ceiling. New files start under the budget.
const MAX_LINES = 1000;

const GRANDFATHER: Record<string, number> = {
	'src/lib/chat/conversation/conversation-session-controller.svelte.ts': 1350,
	'src/lib/workspace/workspace-coordinator.svelte.ts': 1075,
	'src/lib/chat/tools/tool-display-registry.ts': 1075,
	'src/lib/components/sidebar/SidebarVirtualSortableChatList.svelte': 1050,
	'src/lib/api/git.ts': 1025,
};

// paraglide is generated; it is not hand-written production code.
const SKIP_DIRS = new Set(['__tests__', 'node_modules', 'paraglide']);

function productionFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : productionFiles(path);
		if (entry.name.endsWith('.test.ts')) return [];
		return entry.name.endsWith('.ts') || entry.name.endsWith('.svelte') ? [path] : [];
	});
}

function lineCount(file: string): number {
	return readFileSync(file, 'utf8').split('\n').length;
}

const files = productionFiles('src/lib');

describe('web architecture budgets', () => {
	test('discovers a plausible number of production files', () => {
		expect(files.length).toBeGreaterThan(100);
	});

	test('no production file exceeds its line budget', () => {
		for (const file of files) {
			const ceiling = GRANDFATHER[file] ?? MAX_LINES;
			const lines = lineCount(file);
			expect(lines, `${file} has ${lines} lines (ceiling ${ceiling})`).toBeLessThanOrEqual(ceiling);
		}
	});

	test('grandfather entries stay above the budget and reference real files', () => {
		for (const [file, ceiling] of Object.entries(GRANDFATHER)) {
			expect(existsSync(file), `grandfathered file missing; remove it: ${file}`).toBe(true);
			expect(ceiling).toBeGreaterThan(MAX_LINES);
			const lines = lineCount(file);
			expect(
				lines,
				`${file} is ${lines} lines, at or below ${MAX_LINES}; remove it from GRANDFATHER`,
			).toBeGreaterThan(MAX_LINES);
		}
	});
});
