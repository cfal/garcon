<script lang="ts">
	import { setFileSessions } from '$lib/context';
	import FileDirtyUnloadGuard from '../FileDirtyUnloadGuard.svelte';

	let { dirty }: { dirty: boolean } = $props();
	setFileSessions({
		get hasDirtySessions() {
			return dirty;
		},
	} as never);
</script>

<FileDirtyUnloadGuard />
