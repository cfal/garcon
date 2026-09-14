import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

export function canSubmitFileWrite(session: FileViewSession): boolean {
	return !(
		session.rendererMode === 'image' ||
		session.loading ||
		session.saving ||
		session.refreshing ||
		// Mutation guards include unknown Save outcomes, even when observed disk content matches.
		session.document.mutationGuarded ||
		!session.loadedRevision ||
		session.readOnly ||
		session.document.mixedLineEndings
	);
}

export function canSaveFileChanges(session: FileViewSession): boolean {
	return session.dirty && canSubmitFileWrite(session);
}
