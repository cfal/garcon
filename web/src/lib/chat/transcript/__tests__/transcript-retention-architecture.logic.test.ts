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

	it('[TLV5-DISPLAY.01-WEB-STATIC-01] uses one certified read path instead of scanning hidden raw rows', () => {
		const activeTranscript = transcriptSource('active-transcript-state.svelte.ts');

		expect(activeTranscript).toContain('DisplayWindowController');
		expect(activeTranscript).not.toMatch(/getChatMessages|loadTranscriptPageDemand|applyMessages|transcriptCache/);
		expect(transcriptSource('display-window-controller.ts')).not.toContain('collapsedGroupByMemberRowId');
	});
});
