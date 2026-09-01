<script lang="ts">
	interface Props {
		onAbort?: (() => void) | null;
		composerEditorOpenRequestId?: number;
		requiresQueuedSubmission?: boolean;
		[key: string]: unknown;
	}

	let {
		onAbort = null,
		composerEditorOpenRequestId = 0,
		requiresQueuedSubmission = false,
	}: Props = $props();
</script>

<button type="button" onclick={() => onAbort?.()}>Abort</button>
<div data-testid="composer-editor-open-request">{composerEditorOpenRequestId}</div>
<div data-testid="composer-requires-queued-submission">{String(requiresQueuedSubmission)}</div>
