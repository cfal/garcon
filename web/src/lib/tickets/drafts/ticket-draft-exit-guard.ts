import type { TicketDraftStore } from './ticket-draft-store.svelte.js';
import { isBrowserDataCurrent } from '$lib/utils/browser-data-lifetime';

export function attachTicketDraftExitGuard(drafts: TicketDraftStore): () => void {
	if (typeof window === 'undefined') return () => {};
	const preserve = () => {
		if (isBrowserDataCurrent()) drafts.flush();
	};
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (!isBrowserDataCurrent() || !drafts.needsExitGuard) return;
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
