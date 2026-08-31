import type { ConversationUiState } from '../conversation-ui-state.svelte.js';

export function mountConversationUiPruning(
	store: ConversationUiState,
	getActiveChatIds: () => Set<string>,
): () => void {
	return $effect.root(() => {
		store.mountExecutionControlPruning({ getActiveChatIds });
	});
}
