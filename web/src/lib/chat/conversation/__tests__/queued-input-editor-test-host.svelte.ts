import { QueuedInputEditorState } from '../queued-input-editor-state.svelte';
import type { QueueState } from '$lib/types/chat';

export class QueuedInputEditorTestHost {
	queue = $state<QueueState | null>(null);
	readonly editor: QueuedInputEditorState;

	constructor(queue: QueueState) {
		this.queue = queue;
		const getQueue = () => this.queue;
		this.editor = new QueuedInputEditorState({
			get queue() {
				return getQueue();
			},
		});
	}
}
