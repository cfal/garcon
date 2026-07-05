<script lang="ts">
	interface Props {
		onAbort?: (() => void) | null;
		[key: string]: unknown;
	}

	let { onAbort = null }: Props = $props();
</script>

<button type="button" onclick={() => onAbort?.()}>Abort</button>
