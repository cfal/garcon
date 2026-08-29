import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const transcriptSource = (file: string) => readFileSync(`src/lib/chat/transcript/${file}`, 'utf8');

describe('transcript retention architecture', () => {
	it('[TLV5-UX.17-WEB-STATIC-01] has no timer-driven active transcript compaction path', () => {
		const controller = transcriptSource('conversation-scroll-controller.svelte.ts');
		const activeTranscript = transcriptSource('active-transcript-state.svelte.ts');
		const mutations = transcriptSource('conversation-feed-mutations.ts');

		expect(controller).not.toMatch(
			/LIVE_EDGE_PRUNE_IDLE_MS|liveEdgePrune|compactAtVerifiedLiveEdge|compactToRecentMessages/,
		);
		expect(activeTranscript).not.toContain('compactToRecentMessages');
		expect(mutations).not.toContain("'history-pruned'");
	});

	it('[TLV5-PAGE.09-WEB-STATIC-01] shares visible-demand paging across active, background, and window-preview loads', () => {
		const activeTranscript = transcriptSource('active-transcript-state.svelte.ts');
		const backgroundLoader = transcriptSource('background-transcript-loader.ts');
		const windowPreview = readFileSync(
			'src/lib/chat/transcript/chat-window-preview-store.svelte.ts',
			'utf8',
		);

		for (const source of [activeTranscript, backgroundLoader, windowPreview]) {
			expect(source).toMatch(
				/import[\s\S]*\bloadTranscriptPageDemand\b[\s\S]*from\s+['"][^'"]*transcript-page-demand\.js['"]/,
			);
			expect(source).toMatch(/\bloadTranscriptPageDemand\s*\(/);
		}
	});
});
