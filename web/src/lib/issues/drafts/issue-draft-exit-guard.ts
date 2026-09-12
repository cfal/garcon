import type { IssueDraftStore } from './issue-draft-store.svelte.js';

export function attachIssueDraftExitGuard(drafts: IssueDraftStore): () => void {
	if (typeof window === 'undefined') return () => {};
	const preserve = () => drafts.flush();
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (!drafts.needsExitGuard) return;
		preserve();
		event.preventDefault();
		event.returnValue = '';
	};
	window.addEventListener('pagehide', preserve);
	window.addEventListener('beforeunload', beforeUnload);
	return () => {
		window.removeEventListener('pagehide', preserve);
		window.removeEventListener('beforeunload', beforeUnload);
	};
}
