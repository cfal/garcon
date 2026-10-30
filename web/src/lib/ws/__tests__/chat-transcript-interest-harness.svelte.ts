import { ChatTranscriptInterestController } from '../chat-transcript-interest.svelte.js';
import type { TranscriptInterestConnectionPort } from '../chat-transcript-interest.svelte.js';

export function mountTranscriptInterest(connection: TranscriptInterestConnectionPort) {
	const displayed = $state<{ chatIds: string[] }>({ chatIds: [] });
	const controller = new ChatTranscriptInterestController(connection);
	const cleanup = $effect.root(() => {
		controller.mount(() => displayed.chatIds);
	});
	return {
		controller,
		display(chatIds: string[]) {
			displayed.chatIds = chatIds;
		},
		cleanup,
	};
}
