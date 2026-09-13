import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import type { FileViewSession } from '$lib/files/sessions/file-view-session.svelte.js';

export function promoteDirtyPreviewViews(
	document: FileDocumentState,
	getSession: (viewId: string) => FileViewSession | null,
	onPromoted: (session: FileViewSession) => void,
): void {
	if (!document.dirty) return;
	for (const viewId of document.viewIds) {
		const session = getSession(viewId);
		if (!session?.preview) continue;
		session.preview = false;
		session.pinned = true;
		onPromoted(session);
	}
}

export function promoteExplicitFileOpen(session: FileViewSession, previewRequested: boolean): void {
	if (previewRequested) return;
	session.preview = false;
	session.pinned = true;
}
