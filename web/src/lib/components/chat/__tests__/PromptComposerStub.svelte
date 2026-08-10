<script lang="ts">
	interface Props {
		onAbort?: (() => void) | null;
		composerEditorOpenRequestId?: number;
		[key: string]: unknown;
	}

	let { onAbort = null, composerEditorOpenRequestId = 0 }: Props = $props();
</script>

<button type="button" onclick={() => onAbort?.()}>Abort</button>
<div data-testid="composer-editor-open-request">{composerEditorOpenRequestId}</div>
