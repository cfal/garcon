<script lang="ts">
	import { getFileSessions } from '$lib/context';

	const files = getFileSessions();

	$effect(() => {
		if (!files.hasUnloadProtectedSessions) return;
		const preventDirtyUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', preventDirtyUnload);
		return () => window.removeEventListener('beforeunload', preventDirtyUnload);
	});

	$effect(() => {
		const flushRecovery = () => {
			void files.flushRecovery();
		};
		const handleVisibility = () => {
			if (document.visibilityState === 'hidden') flushRecovery();
		};
		window.addEventListener('pagehide', flushRecovery);
		document.addEventListener('visibilitychange', handleVisibility);
		return () => {
			window.removeEventListener('pagehide', flushRecovery);
			document.removeEventListener('visibilitychange', handleVisibility);
		};
	});
</script>
