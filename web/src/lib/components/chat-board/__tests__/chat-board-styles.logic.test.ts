import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('../../../../app.css', import.meta.url), 'utf8');
const componentSources = [
	'../ChatBoardCard.svelte',
	'../ChatBoardEmptyState.svelte',
	'../ChatBoardLane.svelte',
	'../ChatBoardPanel.svelte',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

describe('Chat Board styles', () => {
	it('defines every referenced Chat Board color utility', () => {
		const utilities = new Set(
			componentSources.flatMap((source) =>
				[...source.matchAll(/\b(?:bg|border)-(chat-board-[a-z-]+)/g)].map((match) => match[1]),
			),
		);

		for (const utility of utilities) {
			expect(appCss).toContain(`--color-${utility}:`);
		}
	});

	it('disables decorative board motion for both reduced-motion controls', () => {
		expect(appCss).toMatch(
			/\.chat-board-reduce-motion \[data-chat-board-skeleton\],[\s\S]*?\[data-chat-board-column-id\] \{\s*animation: none;\s*transition: none;\s*\}/,
		);
		expect(appCss).toMatch(
			/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\[data-chat-board-skeleton\],[\s\S]*?\[data-chat-board-column-id\] \{\s*animation: none;\s*transition: none;\s*\}/,
		);
		expect(appCss).toMatch(
			/\.chat-board-reduce-motion \[data-chat-board-occurrence\]:hover \{\s*transform: none;\s*\}/,
		);
		expect(appCss).toMatch(
			/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\[data-chat-board-occurrence\]:hover \{\s*transform: none;\s*\}/,
		);
	});
});
