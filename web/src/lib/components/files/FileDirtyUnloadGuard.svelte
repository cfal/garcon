<script lang="ts">
	import { getFileSessions } from '$lib/context';
	import { isBrowserDataCurrent } from '$lib/utils/browser-data-lifetime';

	const files = getFileSessions();

	$effect(() => {
		if (!files.hasUnloadProtectedSessions) return;
		const preventDirtyUnload = (event: BeforeUnloadEvent) => {
			if (!isBrowserDataCurrent()) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', preventDirtyUnload);
		return () => window.removeEventListener('beforeunload', preventDirtyUnload);
	});

	$effect(() => {
		const flushRecovery = () => {
			if (!isBrowserDataCurrent()) return;
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
