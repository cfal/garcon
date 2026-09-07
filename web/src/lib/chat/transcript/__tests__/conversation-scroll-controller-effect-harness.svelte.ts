import type { ConversationScrollController } from '../conversation-scroll-controller.svelte';

export function mountInitialBottomRestoreEffect(
	controller: ConversationScrollController,
	getAutoScrollToBottom: () => boolean = () => true,
): () => void {
	return $effect.root(() => {
		$effect(() => controller.reconcileInitialBottomRestore(getAutoScrollToBottom()));
	});
}
