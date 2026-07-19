import { QueuedInputEditorState } from '../queued-input-editor-state.svelte';
import type { ChatQueueState } from '$lib/types/chat';

export class QueuedInputEditorTestHost {
	queue = $state<ChatQueueState | null>(null);
	readonly editor: QueuedInputEditorState;

	constructor(queue: ChatQueueState) {
		this.queue = queue;
		const getQueue = () => this.queue;
		this.editor = new QueuedInputEditorState({
			get queue() {
				return getQueue();
			},
		});
	}
}
