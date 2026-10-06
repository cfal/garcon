import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const transcriptSource = (file: string) => readFileSync(`src/lib/chat/transcript/${file}`, 'utf8');

describe('transcript retention architecture', () => {
	it('keeps raw transcript arrays assignment-driven', () => {
		expect(transcriptSource('active-transcript-presentation-state.svelte.ts')).toContain('entries = $state.raw<');
		for (const file of ['active-transcript-state.svelte.ts', 'active-transcript-presentation-state.svelte.ts', 'transcript-page-loader.ts']) {
			expect(transcriptSource(file)).not.toMatch(/\.entries\s*\.\s*(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\s*\(/);
			expect(transcriptSource(file)).not.toMatch(/\.entries\s*\[[^\]]+\]\s*=/);
		}
	});
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

	it('[TLV5-PAGE.09-WEB-STATIC-01] routes rendered-panel snapshots through visible-demand paging', () => {
		const activeTranscript = transcriptSource('active-transcript-state.svelte.ts');

		expect(activeTranscript).toMatch(
			/import[\s\S]*\bloadTranscriptPageDemand\b[\s\S]*from\s+['"][^'"]*transcript-page-demand\.js['"]/,
		);
		expect(activeTranscript).toMatch(/\bloadTranscriptPageDemand\s*\(/);
	});
});
