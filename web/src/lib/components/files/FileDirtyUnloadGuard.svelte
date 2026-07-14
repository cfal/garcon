<script lang="ts">
	import { getFileSessions } from '$lib/context';

	const files = getFileSessions();

	$effect(() => {
		if (!files.hasDirtySessions) return;
		const preventDirtyUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', preventDirtyUnload);
		return () => window.removeEventListener('beforeunload', preventDirtyUnload);
	});
</script>
